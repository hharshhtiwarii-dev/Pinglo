/**
 * shareSend — ROADMAP-2 #8 last mile (Worker R2B).
 *
 * The send half of the share target. Worker R1B built the native intent
 * path + the shareIntent.ts bridge (the payload waits in localStorage);
 * the SharePickerScreen calls these helpers once the user picks a chat.
 *
 * These are NOT a new send path: they call exactly the same public APIs
 * ChatScreen's own send uses, with the same field shapes, so a shared
 * message is indistinguishable from one typed in the chat:
 *  - text: `addDoc(collection(db, 'chats', <conv>, 'messages'), …)` —
 *    the write goes through database.ts `putRaw`, so 1-to-1 text gets
 *    the same E2EE encryption (and the same fail-closed behaviour when
 *    the keys are not exchanged) as a typed message, and the same
 *    offline-outbox queueing on a network failure.
 *  - files: the same optimistic-placeholder pattern as ChatScreen's
 *    `sendFile` — placeholder doc with a local blob URL + `uploading`,
 *    then `uploadChatMedia` (`uploadChatMediaWithPoster` for video) and
 *    an `updateDoc` patch with the final URL. Files shared together get
 *    one `albumId`, like a multi-pick in the chat.
 *  - realtime relay: `realtimeSync.sendMessage` for 1-to-1 chats only —
 *    ChatScreen skips the relay for groups and for Saved Messages, and
 *    so do we.
 *
 * Targets:
 *  - DM: { kind: 'dm', chatId: <peer uid>, conversationId: <uidA_uidB> }
 *  - group/community: { kind: 'group', chatId: <community id>,
 *    conversationId: cleanId(<community id>) }
 *  - Saved Messages: { kind: 'saved', chatId: <own uid>,
 *    conversationId: `saved_<uid>` } — the same collection
 *    SavedMessagesScreen reads and sends into.
 *
 * Honest limits (also shown by the picker):
 *  - No reply-to, no View Once, no silent-send on a share — the sender
 *    shared from another app, there is no composer state to carry.
 *  - Text over MAX_MESSAGE_CHARS (5,000) is refused, never silently
 *    truncated — the same limit ChatScreen enforces.
 *  - A file the device cannot read (native cache file gone, or the web
 *    where fileForRef() is always null) fails by name; the rest still
 *    sends. The caller reports the failures — nothing is silently lost.
 *  - A non-encryption send failure means the doc is already in the
 *    offline outbox (putRaw queues before throwing), so it reports as
 *    'queued', exactly like ChatScreen's sendTextNow — never as a loss.
 */

import { addDoc, collection, db, doc, serverTimestamp, updateDoc } from '../aws/database';
import { uploadChatMedia, uploadChatMediaWithPoster, validateChatMediaFile, type MediaType } from '../aws/storage';
import { isEncryptionFailedError } from './e2eeChat';
import { MAX_MESSAGE_CHARS } from './offlineQueue';
import { cleanId, realtimeSync } from './realtimeSync';

export type ShareTargetKind = 'dm' | 'group' | 'saved';

export interface ShareTarget {
  kind: ShareTargetKind;
  /** Route chat id: peer uid (DM), community id (group), own uid (saved). */
  chatId: string;
  /** Message collection id: `chats/<conversationId>/messages`. */
  conversationId: string;
  /** Display name for the result copy. */
  name: string;
}

export interface ShareSender {
  uid: string;
  displayName?: string | null;
  photoURL?: string | null;
}

export type TextSendResult = 'sent' | 'queued' | 'failed';

export interface FileSendResult {
  name: string;
  ok: boolean;
  /** 'sent' | 'queued' (placeholder queued, upload pending) | 'failed'. */
  status: 'sent' | 'queued' | 'failed';
  /** Human-readable reason when not sent (validation / upload / read). */
  reason?: string;
}

export function mediaTypeForFile(file: File): MediaType {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Send shared text to a picked chat. Same doc shape as ChatScreen's
 * sendTextNow (minus reply/silent, which a share has no composer for).
 * Returns 'queued' when the write failed but putRaw already parked the
 * doc in the offline outbox — it WILL send on reconnect.
 */
export async function sendSharedText(
  target: ShareTarget,
  sender: ShareSender,
  text: string,
): Promise<TextSendResult> {
  const txt = (text || '').trim();
  if (!txt || !target.conversationId || !sender.uid) return 'failed';
  if (txt.length > MAX_MESSAGE_CHARS) return 'failed';
  const msgData: Record<string, unknown> = {
    text: txt,
    senderId: sender.uid,
    senderName: sender.displayName || 'User',
    senderAvatar: sender.photoURL || '',
    timestamp: serverTimestamp(),
    status: 'sent',
  };
  try {
    await addDoc(collection(db, 'chats', target.conversationId, 'messages'), msgData);
    if (target.kind === 'dm') {
      try {
        realtimeSync.sendMessage(target.chatId, {
          conversationId: target.conversationId,
          senderId: sender.uid,
          senderName: sender.displayName || 'User',
          senderAvatar: sender.photoURL || '',
          text: txt,
          timestamp: Date.now(),
        } as any);
      } catch {
        // Best-effort relay only — the message itself already sent.
      }
    }
    return 'sent';
  } catch (e) {
    // Fail-closed E2EE: nothing was sent or queued.
    if (isEncryptionFailedError(e)) return 'failed';
    // Any other failure: putRaw queued the doc in the offline outbox
    // before throwing (same as ChatScreen's 'queued' branch).
    return 'queued';
  }
}

/**
 * Send one shared file to a picked chat. Same placeholder → upload →
 * patch flow as ChatScreen's sendFile. A validation failure returns
 * { ok: false } with the exact reason (e.g. "This image is too large.
 * You can send images up to 15 MB.") instead of throwing; an upload
 * placeholder marked `uploadFailed: true` instead of a silent loss.
 */
export async function sendSharedFile(
  target: ShareTarget,
  sender: ShareSender,
  file: File,
  albumId?: string,
): Promise<FileSendResult> {
  const type = mediaTypeForFile(file);
  try {
    validateChatMediaFile(file, type);
  } catch (e: unknown) {
    return {
      name: file.name,
      ok: false,
      status: 'failed',
      reason: e instanceof Error ? e.message : 'Upload failed. Please try again.',
    };
  }
  const isVideo = type === 'video';
  const isAudio = type === 'audio';
  const isImage = type === 'image';
  const textLabel = isVideo
    ? '📹 Video'
    : isAudio
      ? '🎵 Audio'
      : isImage
        ? '📷 Photo'
        : `📄 ${file.name}`;
  const localUrl = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(file) : '';
  let placeholderId: string;
  try {
    const ref = await addDoc(collection(db, 'chats', target.conversationId, 'messages'), {
      text: textLabel,
      senderId: sender.uid,
      senderName: sender.displayName || 'User',
      senderAvatar: sender.photoURL || '',
      timestamp: serverTimestamp(),
      status: 'sent',
      mediaUrl: localUrl,
      mediaType: type,
      uploading: true,
      uploadProgress: 0,
      ...(albumId ? { albumId } : {}),
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || '',
    });
    placeholderId = ref.id;
  } catch (e) {
    if (localUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(localUrl);
    // The placeholder never landed: encryption failed outright, or the
    // doc is queued in the offline outbox and will send on reconnect.
    if (isEncryptionFailedError(e)) {
      return { name: file.name, ok: false, status: 'failed', reason: 'Encryption failed — message not sent. Try again once the keys are exchanged.' };
    }
    return { name: file.name, ok: false, status: 'queued', reason: 'Offline — queued, will send when reconnected.' };
  }
  try {
    let mediaUrl: string;
    let posterUrl: string | null | undefined;
    if (isVideo) {
      const up = await uploadChatMediaWithPoster(file, type, false);
      mediaUrl = up.url;
      posterUrl = up.posterUrl;
    } else {
      mediaUrl = await uploadChatMedia(file, type, false);
    }
    await updateDoc(doc(db, 'chats', target.conversationId, 'messages', placeholderId), {
      mediaUrl,
      uploading: false,
      uploadProgress: 100,
      ...(posterUrl ? { posterUrl } : {}),
    });
    if (target.kind === 'dm') {
      try {
        realtimeSync.sendMessage(target.chatId, {
          conversationId: target.conversationId,
          senderId: sender.uid,
          senderName: sender.displayName || 'User',
          senderAvatar: sender.photoURL || '',
          text: textLabel,
          mediaUrl,
          mediaType: type,
          ...(albumId ? { albumId } : {}),
          fileName: file.name,
          fileSize: file.size,
          fileType: file.type || '',
          timestamp: Date.now(),
        } as any);
      } catch {
        // Best-effort relay only — the message itself already sent.
      }
    }
    return { name: file.name, ok: true, status: 'sent' };
  } catch (e: unknown) {
    try {
      await updateDoc(doc(db, 'chats', target.conversationId, 'messages', placeholderId), {
        uploadFailed: true,
        uploading: false,
      });
    } catch {
      // The failure mark is best-effort; the placeholder itself says it.
    }
    const reason =
      e instanceof Error && /smaller than|not allowed|Invalid/i.test(e.message)
        ? e.message
        : 'Upload failed. Please try again.';
    return { name: file.name, ok: false, status: 'failed', reason };
  }
}

/** Group conversation id for a community chat id (same as ChatScreen). */
export function groupConversationId(chatId: string): string {
  return cleanId(chatId);
}
