/**
 * Core chat shapes for Pinglo.
 *
 * Single source of truth for the message / user shapes that used to be
 * `any` throughout the chat screens (Ponytail audit: ChatScreen.tsx alone
 * carried 57 `: any` annotations). Message docs arrive from Firestore /
 * the local DB layer as schemaless records, so every field except `id` is
 * optional — a doc written by an older client (or a partially-decrypted
 * one) may legitimately miss fields. Callers must still narrow before
 * use; the types only stop the compiler from waving everything through.
 */
import type { ReactNode } from 'react';
import type { ReactionMap } from '../services/reactions';

/** Message kinds written to `chats/<cid>/messages`. No `type` field means a plain text message. */
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'file'
  | 'sticker'
  | 'gif'
  | 'poll'
  | 'location'
  | 'live-location'
  | 'contact'
  | 'system'
  | 'deleted'
  | 'reaction';

/** Media kind carried on a message (`mediaType`). */
export type MediaType = 'image' | 'video' | 'audio' | 'file';

/** Delivery state stored on a message doc. Derived seen/delivered state
 * lives in the read-receipt watermarks, not here. 'pending' / 'queued'
 * (Wave-2 A5, DM #41) is the not-yet-sent state — WA shows a clock icon
 * for it; `effectiveMessageStatus()` also derives it from `uploading`. */
export type MessageStatus = 'sent' | 'delivered' | 'seen' | 'pending' | 'queued';

/** E2EE marker written by the decrypt pipeline (see e2eeChat.ts). */
export type MessageEncryption = 'e2ee' | 'decrypt-failed' | 'legacy';

/** A Firestore Timestamp (or any object with a `toDate()`), as stored on
 * message docs before the read hook normalises it. */
export interface FirestoreTimestampLike {
  toDate(): Date;
  seconds?: number;
  nanoseconds?: number;
}

/**
 * Anything a message `timestamp` / `editedAt` field can hold at runtime:
 * epoch ms (the local `serverTimestamp()` returns `Date.now()`), an ISO
 * string, a Date, or a Firestore Timestamp. Absent while the doc is
 * being written.
 */
export type MessageTimestamp =
  | number
  | string
  | Date
  | FirestoreTimestampLike
  | null
  | undefined;

/** The quoted message attached to a reply. Cross-chat quotes (Reply
 * privately) additionally carry their origin chat. */
export interface MessageReply {
  id: string;
  text?: string;
  senderName?: string;
  fromChatId?: string;
  fromChatName?: string;
}

/** One entry of a message's edit history (`editHistory` array). */
export interface MessageEditEntry {
  text: string;
  /** Epoch ms of the superseded version. */
  at?: number;
  editedAt?: number;
}

/** Poll votes: legacy single-answer `Record<uid, optIdx>` or multi-answer
 * `Record<uid, optIdx[]>` — mixed across voters (see PollCard). */
export type PollVotes = Record<string, number | number[]>;

/**
 * A chat message doc (`chats/<cid>/messages/<id>`). Only `id` is
 * guaranteed — everything else is optional because docs come from
 * schemaless Firestore records and older clients.
 */
export interface ChatMessage {
  id: string;
  senderId?: string;
  senderName?: string;
  senderAvatar?: string;
  timestamp?: MessageTimestamp;
  type?: MessageType;
  status?: MessageStatus;
  text?: string;
  caption?: string;
  mediaUrl?: string;
  mediaType?: MediaType;
  /** Wave-2 A5 (DM #78): MP4 variant of a GIF message (Giphy
   * `original_mp4`), when the sender's client had one. The bubble
   * renders it as a looping autoplay <video>; `mediaUrl` stays the
   * .gif so the gallery / lightbox / download paths keep working. */
  gifVideoUrl?: string;
  posterUrl?: string;
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  /** Voice-note length in seconds. */
  duration?: number;
  /** Voice-note waveform peaks. */
  waveform?: number[];
  replyTo?: MessageReply;
  /** uid -> emoji (see services/reactions.ts `ReactionMap`). */
  reactions?: ReactionMap;
  deleted?: boolean;
  edited?: boolean;
  editedAt?: MessageTimestamp;
  editHistory?: MessageEditEntry[];
  editHistoryTruncated?: boolean;
  kept?: boolean;
  keptAt?: MessageTimestamp;
  keptBy?: string | null;
  /** Silent send — the push watcher must skip notifying. */
  silent?: boolean;
  uploading?: boolean;
  uploadFailed?: boolean;
  /** 0–100 upload progress for the local placeholder. */
  uploadProgress?: number;
  /** Shared by files sent together; renders as one album bubble. */
  albumId?: string;
  isViewOnce?: boolean;
  isRoundVideo?: boolean;
  pollQuestion?: string;
  pollOptions?: string[];
  pollVotes?: PollVotes;
  pollMultiAnswer?: boolean;
  pollMaxChoices?: number;
  latitude?: number;
  longitude?: number;
  locationLabel?: string;
  locationAccuracy?: number;
  liveLocationId?: string;
  liveLocationActive?: boolean;
  liveLocationExpiresAt?: number;
  liveLocationUpdatedAt?: number;
  contactName?: string;
  contactPhone?: string;
  contactUid?: string;
  contactAvatar?: string;
  stickerLabel?: string;
  stickerImage?: string;
  stickerEmoji?: string;
  stickerAnimation?: string;
  /** WA parity Media G6: GIF provider attribution (WA
   *  `VideoMessage$Attribution`, e.g. `'GIPHY'`) — stored on sent GIF
   *  messages and rendered on the GIF bubble. Absent for pasted-link
   *  GIFs, whose provider is unknown (never invented). */
  gifAttribution?: string;
  forwardedFrom?: string;
  encryption?: MessageEncryption;
  decryptError?: boolean;
  /** Encrypted envelope (object) when the doc carries an E2EE body. */
  e2ee?: Record<string, unknown> | null;
  /** MF-01 (scaffold): set when the receiver opens a view-once message
   * (VO-03: written in the same action as the viewer open, one
   * updateDoc — see services/viewOnce.ts `markViewOnceViewed`). */
  viewed?: boolean;
  /** MF-01 (scaffold): epoch ms the view-once message was opened. */
  viewedAt?: number;
  /** MF-01 (scaffold, TODO — Hermes "screenshot tripwire"): set when
   * the OS reports a screenshot attempt while the view-once viewer is
   * open. No writer exists yet; do not read this as enforced. */
  screenshotAttempted?: boolean;
  deliveredAt?: number;
  seenAt?: number;
  /** Cross-chat quote origin (Reply privately) riding on a message-shaped object. */
  fromChatId?: string;
  fromChatName?: string;
}

/** Payload for a new message write — a `ChatMessage` without the doc id
 * (Firestore assigns it). */
export type NewChatMessage = Omit<ChatMessage, 'id'>;

/**
 * A user / contact record as read from the `users` collection or the
 * contacts cache. Both `id` (doc id) and `uid` (auth uid) occur in the
 * wild, as do `phone` and `phoneNumber` — hence the alternates.
 */
export interface ChatUser {
  id?: string;
  uid?: string;
  displayName?: string;
  username?: string;
  phone?: string;
  phoneNumber?: string;
  photoURL?: string | null;
  avatar?: string;
}

/** One entry of a media-manifest row for a saved chat transcript
 * (see `archiveMediaManifest` in ChatScreen). */
export interface ArchivedMediaItem {
  messageId: string | null;
  mediaType: MediaType | null;
  fileName: string | null;
  fileSize: number | null;
  duration: number | null;
  /** Present only for remote URLs; local-only media is flagged instead
   * (the bytes already live on the original message doc). */
  mediaUrl?: string;
  localOnly?: boolean;
  posterUrl?: string;
}

/** One row of a context / overflow menu (`icon` is a JSX icon for the
 * context menu, an emoji string for the attach sheet, or absent). */
export interface ChatMenuItem {
  icon?: ReactNode;
  label: string;
  action: () => void;
  danger?: boolean;
}
