/**
 * Realtime relay for Pinglo — now backed by AWS AppSync + DynamoDB.
 *
 * The old version pushed message payloads through the public MQTT broker
 * (broker.emqx.io), which exposed chat content and duplicated every write.
 * Messages, reactions and deletes are now persisted to the shared store, and
 * every device receives them through AppSync subscriptions. This module keeps
 * the same API so screens don't change; only typing status still uses its own
 * (short-lived) document.
 *
 * AUDIT-2 C1/C2 (Phase 2, Worker 3A) — typing subscriptions are now SCOPED
 * and REFCOUNTED instead of one whole-`typing`-collection subscription per
 * caller:
 * - When the chat partner is known (ChatScreen calls joinConversation(cid,
 *   partnerUid) before the typing effect mounts, and onTypingChange also
 *   accepts an explicit partnerId), the hub subscribes to that ONE typing
 *   doc (`typing/<cid>_<partnerUid>`) instead of the whole collection.
 *   A typing event in any other conversation never reaches this chat's
 *   callback path at all.
 * - When the partner is NOT known, all such conversations SHARE one single
 *   whole-collection subscription (fan-out in memory, notify-on-flip per
 *   conversation) instead of one subscription per caller.
 * - The last listener leaving a conversation unsubscribes its underlying
 *   subscription immediately; cleanup() (sign-out) tears the whole hub
 *   down, so no listener dangles after unmount / sign-out.
 * - Re-subscribe on `online` / foreground: an entry whose underlying handle
 *   was ever cleared is re-attached, and `lastNotified` is reset on every
 *   attach so the fresh initial snapshot is delivered even if the value
 *   equals the pre-drop value (no stale-data window after re-open).
 * - pruneStaleTyping(conversationId) no longer reads the whole collection:
 *   it checks only the two docs that can exist for that conversation
 *   (mine + the partner's) via getDoc.
 *
 * HONEST LIMIT — the byte saving is partial until database.ts changes:
 * db.subscribe() still calls ensure('typing'), which loads the whole
 * `typing` collection and starts its 3 s poll (fetchAll still transfers
 * every doc each tick; only the *notify* is rev-gated today). So the
 * doc-scoped subscription saves snapshot delivery + callback fan-out
 * now, and saves the transfer only once database.ts gains a rev-probe
 * poll + a scoped-query helper (exact change recorded in
 * security-audit/phase2/PATCH-3A.md §6; BACKEND-PLAN.md §16 for the
 * server-side filter). The hub is written so that day it just works:
 * the doc path is already the primary path.
 */

import { db, setDoc, deleteDoc, doc, getDoc, onSnapshot, collection, setDeliveredMarkerUser } from '../aws';
import { setPresenceAudience, setPresenceOpenChats } from './presence';

export const cleanId = (id: string): string => {
  return (id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
};

/**
 * Partner uid for a DM conversation id, or null for groups / saved chats.
 * DM ids are `getConversationId(uidA, uidB)` = two `cleanId` outputs joined
 * with a single '_', so the partner is derived by prefix/suffix, NOT by
 * splitting on '_' — mock uids are 'usr_<uuid>', so a mock–mock DM id
 * splits into 4+ parts and any split-based parse misfires (#236).
 * `saved_<uid>` channels are not DM ids → null (previously the split
 * returned 'saved' as a bogus partner for real uids too).
 * Known residual (stated, not hidden): if one uid were a strict prefix of
 * the other ('usr_abc' vs 'usr_abc_def'), the prefix check could mis-split.
 * Uids in practice are UUIDs / 'usr_<uuid>', where that collision requires
 * a crafted UUID; the explicit-partner and openConversations paths take
 * precedence and are unaffected.
 */
export function partnerIdForConversation(cid: string, myUid: string | null | undefined): string | null {
  // cleanId the id too: ids in practice are getConversationId outputs
  // (already clean), but a dirty id must not silently mis-parse.
  const id = cleanId(cid);
  const me = myUid ? cleanId(myUid) : '';
  if (!id || !me) return null;
  if (id.startsWith('saved_')) return null;
  if (id.startsWith(me + '_')) return id.slice(me.length + 1);
  if (id.endsWith('_' + me)) return id.slice(0, id.length - me.length - 1);
  return null;
}

export const getConversationId = (uidA: string, uidB: string): string => {
  const a = cleanId(uidA);
  const b = cleanId(uidB);
  return [a, b].sort().join('_');
};

/**
 * F2 (100-more): unwrap a full DM conversation id back to the partner uid.
 * The :chatId route param is usually a partner uid, but some flows pass a
 * full DM conversation id (`uidA_uidB`) — the message/call toast tap
 * (NotificationBanner navigates with t.conversationId) and Saved /
 * Starred / Scheduled jump links (stored originalChatId / chatId). A DM
 * id is sort([cleanId(me), cleanId(partner)]).join('_'), so it starts
 * with cleanId(me)+'_' or ends with '_'+cleanId(me); the remainder is
 * the partner uid in cleaned form. Returns null when the param is not a
 * full DM id for this user (plain partner uid, self-chat, group id).
 * The round-trip check matters: a plain partner uid that merely starts
 * or ends with my uid is NOT unwrapped — only a param that re-wraps to
 * itself is a real conversation id.
 * NOTE: the returned uid is in cleaned form. For mock `usr_…` uids that
 * is the raw uid; for real Cognito UUIDs the dashes became underscores,
 * so callers needing the raw user-doc id must resolve it via the users
 * collection (ChatScreen does a cached cleanId scan for the header doc).
 */
export const partnerUidFromConversationId = (param: string, myUid: string): string | null => {
  const me = cleanId(myUid);
  const p = cleanId(param);
  if (!me || !p || p === me) return null;
  let remainder: string | null = null;
  if (p.startsWith(me + '_')) remainder = p.slice(me.length + 1);
  else if (p.endsWith('_' + me)) remainder = p.slice(0, p.length - me.length - 1);
  if (!remainder) return null;
  // Round-trip guard: only a real conversation id re-wraps to itself.
  if (getConversationId(myUid, remainder) !== p) return null;
  return remainder;
};

export interface IncomingMessagePayload {
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar?: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  isViewOnce?: boolean;
  timestamp: number;
  replyTo?: any;
  // Phase 1: location / contact / sticker message payloads (optional).
  type?: string;
  latitude?: number;
  longitude?: number;
  locationLabel?: string;
  locationAccuracy?: number;
  contactName?: string;
  contactPhone?: string;
  contactAvatar?: string;
  // Phase 2 (storage): media file metadata (optional).
  fileName?: string;
  fileSize?: number;
  fileType?: string;
  // Wave-2 A5 (DM #78): MP4 variant of a GIF message (Giphy original_mp4).
  gifVideoUrl?: string;
  /** WA parity Media G6: GIF provider attribution (e.g. 'GIPHY'). */
  gifAttribution?: string;
}

export interface ActionPayload {
  conversationId: string;
  type: 'delete_everyone' | 'reaction' | 'pin';
  msgId: string;
  payload?: any;
}

const TYPING_TTL_MS = 10_000;

/** True when a typing entry (stamped with `at`) is still fresh. */
export function isTypingFresh(at: unknown, now: number = Date.now()): boolean {
  return now - (Number(at) || 0) < TYPING_TTL_MS;
}

type TypingCb = (typing: boolean) => void;

interface TypingEntry {
  conversationId: string;
  /** Cleaned partner uid when known; null → shared-collection fallback. */
  partnerId: string | null;
  listeners: Set<TypingCb>;
  lastNotified: boolean | null;
  /** Underlying doc subscription (doc mode) or null (collection mode / detached). */
  unsub: (() => void) | null;
  /** 'doc' | 'collection' while attached, null while detached. */
  mode: 'doc' | 'collection' | null;
}

/** Diagnostics for probes / debugging — counts, never doc contents. */
export interface TypingDiagnostics {
  conversations: Array<{ conversationId: string; listeners: number; mode: 'doc' | 'collection' | null; partnerKnown: boolean }>;
  /** Underlying subscriptions currently held (doc subs + 0/1 shared collection sub). */
  underlyingSubs: number;
  collectionSubs: number;
  openConversations: number;
}

class RealtimeSyncService {
  private userId: string | null = null;

  /** conversationId → cleaned partner uid (DMs only; null for groups/communities). */
  private openConversations = new Map<string, string | null>();
  private typingEntries = new Map<string, TypingEntry>();
  /** Entries currently served by the single shared whole-collection subscription. */
  private collectionEntries = new Set<TypingEntry>();
  private collectionUnsub: (() => void) | null = null;
  private reconnectListenersAttached = false;

  public init(userId: string, _userProfile?: any) {
    const next = cleanId(userId);
    const changed = this.userId !== next;
    this.userId = next;
    // AUDIT-2 B1: incoming messages become 'delivered' when they reach
    // this device (database.ts marks them on arrival), even when no chat
    // screen is open — the uid is what the marker needs.
    try {
      setDeliveredMarkerUser(this.userId);
    } catch { /* intentionally ignored */}
    // Re-login as a DIFFERENT user with chats still mounted (uid switch):
    // partner ids were derived from the old uid, so re-derive and
    // re-attach any entry whose partner changed. Same-uid refresh is a
    // no-op (partner unchanged → no re-subscribe, no typing flicker).
    if (changed) {
      for (const entry of [...this.typingEntries.values()]) {
        const partner = this.partnerIdFor(entry.conversationId);
        if (partner !== entry.partnerId) {
          entry.partnerId = partner;
          if (entry.listeners.size > 0) this.attachTyping(entry);
        }
      }
    }
  }

  /**
   * Partner uid for a DM conversation, when it can be determined.
   * Sources, in order: explicit partnerId → joinConversation() record →
   * the DM id itself, derived by prefix/suffix (`partnerIdForConversation`).
   * The old code split the id on '_' and required exactly two parts, which
   * breaks for mock uids ('usr_<uuid>': a mock–mock DM id has 4+ parts) —
   * the partner was always null and typing fell back to the whole-collection
   * subscription (#236). Groups/communities (single-part id) and saved
   * channels always return null.
   */
  private partnerIdFor(conversationId: string, explicitPartnerId?: string): string | null {
    const cid = (conversationId || '').trim();
    if (!cid || !this.userId) return null;
    if (explicitPartnerId) {
      const p = cleanId(explicitPartnerId);
      // Accept only if it is one side of this DM id (self-DM included:
      // cid === 'me_me' validates when p === me).
      if (p && cid === [this.userId, p].sort().join('_')) return p;
      return null;
    }
    const open = this.openConversations.get(cid);
    if (open) return open;
    return partnerIdForConversation(cid, this.userId);
  }

  /**
   * Chat opened (ChatScreen calls this with partnerId = chatId for DMs,
   * = community id for groups). Records the open conversation so
   * onTypingChange() can scope to the partner doc, and tells presence
   * that someone is watching live (fast heartbeat while any chat is
   * open — see presence.ts). Community ids are NOT peers: only a
   * two-part DM id yields a partner.
   */
  public joinConversation(conversationId: string, partnerId?: string) {
    const cid = (conversationId || '').trim();
    if (!cid) return;
    const partner = this.partnerIdFor(cid, partnerId);
    this.openConversations.set(cid, partner);
    this.syncPresenceAudience();
    // A typing entry may already exist (effect order is not guaranteed):
    // upgrade it to doc mode now that the partner is known.
    const entry = this.typingEntries.get(cid);
    if (entry && entry.listeners.size > 0 && entry.mode !== 'doc' && partner) {
      entry.partnerId = partner;
      this.attachTyping(entry);
    }
  }

  public leaveConversation(conversationId: string) {
    if (this.openConversations.delete((conversationId || '').trim())) {
      this.syncPresenceAudience();
    }
  }

  private syncPresenceAudience(): void {
    const peers: string[] = [];
    for (const p of this.openConversations.values()) if (p) peers.push(p);
    try {
      setPresenceAudience(peers);
    } catch { /* intentionally ignored */}
    try {
      setPresenceOpenChats(this.openConversations.size);
    } catch { /* intentionally ignored */}
  }

  public requestConversationSync(_targetUserId: string, _conversationId: string) {}

  /** Messages are written to chats/{conversationId}/messages by the screen; nothing else to send. */
  public sendMessage(_targetUserId: string, _payload: IncomingMessagePayload) {}

  /** Reactions, deletes and pins are written to the message doc by the screen. */
  public sendAction(_targetUserId: string, _action: ActionPayload) {}

  public sendTyping(_targetUserId: string, conversationId: string, typing: boolean) {
    if (!this.userId) return;
    const key = `${conversationId}_${this.userId}`;
    if (!typing) {
      // Stopped typing: remove the entry instead of leaving a stale
      // `typing: false` doc that other clients must then expire.
      deleteDoc(doc(null as any, 'typing', key)).catch(() => {});
      return;
    }
    setDoc(doc(null as any, 'typing', key), {
      conversationId,
      uid: this.userId,
      typing,
      at: Date.now(),
    }).catch(() => {});
  }

  // ── WA parity (DM audit, worker B): "recording audio" presence ──
  // Same pattern as typing, but a SEPARATE `recording` collection: the
  // typing doc is deleted on typing-stop, which would wipe a recording
  // state written into the same doc. TTL 15 s; the sender heartbeats
  // every 8 s while recording (ChatScreen), so a long voice note never
  // flickers off. Group typing names use the same typing docs via
  // onTypingUsersChange below (uid list, not just a boolean).
  private recordingEntries = new Map<string, TypingEntry>();
  private collectionRecordingEntries = new Set<TypingEntry>();
  private collectionRecordingUnsub: (() => void) | null = null;

  public sendRecording(_targetUserId: string, conversationId: string, recording: boolean) {
    if (!this.userId) return;
    const key = `${conversationId}_${this.userId}`;
    if (!recording) {
      deleteDoc(doc(null as any, 'recording', key)).catch(() => {});
      return;
    }
    setDoc(doc(null as any, 'recording', key), {
      conversationId,
      uid: this.userId,
      recording,
      at: Date.now(),
    }).catch(() => {});
  }

  private isRecordingFresh(at: unknown, now: number = Date.now()): boolean {
    return now - (Number(at) || 0) < 15_000;
  }

  private notifyRecording(entry: TypingEntry, recording: boolean): void {
    if (recording === entry.lastNotified) return;
    entry.lastNotified = recording;
    for (const cb of [...entry.listeners]) {
      try {
        cb(recording);
      } catch { /* intentionally ignored */}
    }
  }

  private attachRecording(entry: TypingEntry): void {
    if (entry.unsub) {
      try { entry.unsub(); } catch { /* intentionally ignored */}
      entry.unsub = null;
    }
    if (this.collectionRecordingEntries.delete(entry) && this.collectionRecordingEntries.size === 0) {
      if (this.collectionRecordingUnsub) {
        try { this.collectionRecordingUnsub(); } catch { /* intentionally ignored */}
        this.collectionRecordingUnsub = null;
      }
    }
    entry.lastNotified = null;
    entry.mode = null;
    if (entry.partnerId) {
      entry.mode = 'doc';
      const key = `${entry.conversationId}_${entry.partnerId}`;
      entry.unsub = onSnapshot(doc(null as any, 'recording', key), (snap: any) => {
        if (!this.recordingEntries.has(entry.conversationId) || entry.mode !== 'doc') return;
        let recording = false;
        try {
          if (snap?.exists?.()) {
            const x = snap.data();
            if (x && x.uid !== this.userId && x.recording === true && this.isRecordingFresh(x.at)) recording = true;
          }
        } catch { /* intentionally ignored */}
        this.notifyRecording(entry, recording);
      });
      return;
    }
    entry.mode = 'collection';
    this.collectionRecordingEntries.add(entry);
    if (!this.collectionRecordingUnsub) {
      this.collectionRecordingUnsub = onSnapshot(collection(null as any, 'recording'), (snap: any) => {
        const docs = snap?.docs || [];
        const now = Date.now();
        for (const e of [...this.collectionRecordingEntries]) {
          if (e.mode !== 'collection') continue;
          const recording = (docs || []).some((d: any) => {
            const x = typeof d?.data === 'function' ? d.data() : d;
            return x && x.conversationId === e.conversationId && x.uid !== this.userId && x.recording === true && this.isRecordingFresh(x.at, now);
          });
          this.notifyRecording(e, recording);
        }
      });
    }
  }

  /** Partner "recording audio" for one conversation (DMs; groups use the collection path). */
  public onRecordingChange(conversationId: string, cb: (recording: boolean) => void, partnerId?: string): () => void {
    const cid = (conversationId || '').trim();
    let entry = this.recordingEntries.get(cid);
    if (!entry) {
      entry = {
        conversationId: cid,
        partnerId: this.partnerIdFor(cid, partnerId),
        listeners: new Set(),
        lastNotified: null,
        unsub: null,
        mode: null,
      };
      this.recordingEntries.set(cid, entry);
    } else if (partnerId) {
      const p = this.partnerIdFor(cid, partnerId);
      if (p && p !== entry.partnerId) {
        entry.partnerId = p;
        if (entry.listeners.size > 0) this.attachRecording(entry);
      }
    }
    entry.listeners.add(cb);
    if (entry.mode === null) this.attachRecording(entry);
    return () => {
      entry!.listeners.delete(cb);
      if (entry!.listeners.size === 0) {
        if (entry!.unsub) { try { entry!.unsub(); } catch { /* intentionally ignored */} entry!.unsub = null; }
        if (this.collectionRecordingEntries.delete(entry!) && this.collectionRecordingEntries.size === 0) {
          if (this.collectionRecordingUnsub) { try { this.collectionRecordingUnsub(); } catch { /* intentionally ignored */} this.collectionRecordingUnsub = null; }
        }
        entry!.mode = null;
        this.recordingEntries.delete(cid);
      }
    };
  }

  // ── WA parity (DM audit, worker B): group typing NAMES ──
  // The typing hub only reports a boolean, so groups could never show
  // "{Name} is typing". This reports the sorted list of OTHER users with
  // a fresh typing doc in this conversation (uids; the screen resolves
  // names from the member list / message senders). One shared
  // whole-collection subscription for all group listeners.
  private typingUsersEntries = new Map<string, { listeners: Set<(uids: string[]) => void>; lastUids: string[] | null }>();
  private typingUsersUnsub: (() => void) | null = null;

  public onTypingUsersChange(conversationId: string, cb: (uids: string[]) => void): () => void {
    const cid = (conversationId || '').trim();
    let entry = this.typingUsersEntries.get(cid);
    if (!entry) {
      entry = { listeners: new Set(), lastUids: null };
      this.typingUsersEntries.set(cid, entry);
    }
    entry.listeners.add(cb);
    if (!this.typingUsersUnsub) {
      this.attachReconnectListeners();
      this.typingUsersUnsub = onSnapshot(collection(null as any, 'typing'), (snap: any) => {
        const docs = snap?.docs || [];
        const now = Date.now();
        for (const [id, e] of [...this.typingUsersEntries]) {
          const uids = (docs || [])
            .map((d: any) => (typeof d?.data === 'function' ? d.data() : d))
            .filter((x: any) => x && x.conversationId === id && x.uid && x.uid !== this.userId && x.typing === true && isTypingFresh(x.at, now))
            .map((x: any) => String(x.uid))
            .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
            .sort();
          const prev = e.lastUids;
          if (!prev || prev.length !== uids.length || prev.some((u, i) => u !== uids[i])) {
            e.lastUids = uids;
            for (const l of [...e.listeners]) { try { l(uids); } catch { /* intentionally ignored */} }
          }
        }
      });
    }
    return () => {
      entry!.listeners.delete(cb);
      if (entry!.listeners.size === 0) {
        this.typingUsersEntries.delete(cid);
        if (this.typingUsersEntries.size === 0 && this.typingUsersUnsub) {
          try { this.typingUsersUnsub(); } catch { /* intentionally ignored */}
          this.typingUsersUnsub = null;
        }
      }
    };
  }

  /**
   * Delete typing entries for a conversation that are older than the TTL
   * (best-effort). SCOPED (C2): only the two docs that can exist for one
   * conversation are read (mine + the partner's, via getDoc) — the old
   * code read the WHOLE `typing` collection for this. With no
   * conversationId the legacy whole-collection prune is kept (callers:
   * none in the app today — kept for API compatibility).
   */
  public async pruneStaleTyping(conversationId?: string): Promise<void> {
    try {
      if (conversationId) {
        const keys = new Set<string>();
        const partner = this.partnerIdFor(conversationId);
        if (partner) keys.add(`${conversationId}_${partner}`);
        if (this.userId) keys.add(`${conversationId}_${this.userId}`);
        const now = Date.now();
        for (const key of keys) {
          try {
            const snap: any = await getDoc(doc(null as any, 'typing', key));
            if (snap?.exists?.()) {
              const x = snap.data();
              if (x && !isTypingFresh(x.at, now)) {
                await deleteDoc(doc(null as any, 'typing', key)).catch(() => {});
              }
            }
          } catch { /* intentionally ignored */}
        }
        return;
      }
      const snap: any = await new Promise((resolve) => {
        const unsub = onSnapshot(collection(null as any, 'typing'), (s: any) => {
          try {
            unsub();
          } catch { /* intentionally ignored */}
          resolve(s);
        });
      });
      const now = Date.now();
      for (const d of snap?.docs || []) {
        const x = d.data();
        if (!x) continue;
        if (!isTypingFresh(x.at, now)) {
          deleteDoc(doc(null as any, 'typing', d.id)).catch(() => {});
        }
      }
    } catch { /* intentionally ignored */}
  }

  /** Notify one entry's listeners only when the boolean actually flips. */
  private notifyTyping(entry: TypingEntry, typing: boolean): void {
    if (typing === entry.lastNotified) return;
    entry.lastNotified = typing;
    for (const cb of [...entry.listeners]) {
      try {
        cb(typing);
      } catch { /* intentionally ignored */}
    }
  }

  /** Typing boolean for one conversation from a whole-collection snapshot. */
  private typingFromCollectionDocs(entry: TypingEntry, docs: any[]): { typing: boolean; staleIds: string[] } {
    const now = Date.now();
    const staleIds: string[] = [];
    const typing = (docs || []).some((d: any) => {
      const x = typeof d?.data === 'function' ? d.data() : d;
      if (!x || x.conversationId !== entry.conversationId || x.uid === this.userId) return false;
      if (!isTypingFresh(x.at, now)) {
        if (d?.id) staleIds.push(d.id);
        return false;
      }
      return x.typing === true;
    });
    return { typing, staleIds };
  }

  /** (Re-)attach the underlying subscription for one entry. Detaches any previous one first. */
  private attachTyping(entry: TypingEntry): void {
    this.detachTypingUnderlying(entry);
    // Reset so the fresh initial snapshot is always delivered, even if
    // its value equals the pre-drop value (no stale-data window: typing
    // that started while detached must still show after re-open).
    entry.lastNotified = null;
    if (entry.partnerId) {
      entry.mode = 'doc';
      const key = `${entry.conversationId}_${entry.partnerId}`;
      entry.unsub = onSnapshot(doc(null as any, 'typing', key), (snap: any) => {
        // Doc subscription: snapshot is the partner's doc (or empty).
        // The entry may have been detached while the snapshot was in
        // flight — ignore it then.
        if (!this.typingEntries.has(entry.conversationId) || entry.mode !== 'doc') return;
        let typing = false;
        try {
          if (snap?.exists?.()) {
            const x = snap.data();
            if (x && x.uid !== this.userId && x.typing === true && isTypingFresh(x.at)) typing = true;
          }
        } catch { /* intentionally ignored */}
        this.notifyTyping(entry, typing);
      });
      return;
    }
    entry.mode = 'collection';
    this.collectionEntries.add(entry);
    this.ensureCollectionTyping();
  }

  /** Detach only the underlying subscription (keeps the entry + listeners). */
  private detachTypingUnderlying(entry: TypingEntry): void {
    if (entry.unsub) {
      try {
        entry.unsub();
      } catch { /* intentionally ignored */}
      entry.unsub = null;
    }
    if (this.collectionEntries.delete(entry) && this.collectionEntries.size === 0) {
      if (this.collectionUnsub) {
        try {
          this.collectionUnsub();
        } catch { /* intentionally ignored */}
        this.collectionUnsub = null;
      }
    }
    entry.mode = null;
  }

  /** The ONE shared whole-collection subscription for partner-unknown entries. */
  private ensureCollectionTyping(): void {
    if (this.collectionUnsub || this.collectionEntries.size === 0) return;
    this.collectionUnsub = onSnapshot(collection(null as any, 'typing'), (snap: any) => {
      const docs = snap?.docs || [];
      const staleIds = new Set<string>();
      for (const entry of [...this.collectionEntries]) {
        if (entry.mode !== 'collection') continue;
        const { typing, staleIds: ids } = this.typingFromCollectionDocs(entry, docs);
        for (const id of ids) staleIds.add(id);
        this.notifyTyping(entry, typing);
      }
      // Clear stale entries once per snapshot (best-effort).
      for (const id of staleIds) {
        deleteDoc(doc(null as any, 'typing', id)).catch(() => {});
      }
    });
  }

  /** Re-attach entries whose underlying handle was cleared (online / foreground). */
  private reattachTyping(): void {
    this.attachReconnectListeners();
    for (const entry of [...this.typingEntries.values()]) {
      if (entry.listeners.size > 0 && entry.mode === null) this.attachTyping(entry);
    }
  }

  private attachReconnectListeners(): void {
    if (this.reconnectListenersAttached) return;
    this.reconnectListenersAttached = true;
    try {
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('online', () => this.reattachTyping());
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) this.reattachTyping();
        });
      }
    } catch { /* intentionally ignored */}
  }

  /**
   * Partner typing for one conversation. The returned unsubscribe removes
   * this caller; when the LAST listener for the conversation leaves, the
   * underlying subscription is unsubscribed immediately (doc sub, or the
   * shared collection sub when it was the last collection-mode entry).
   * `partnerId` is optional — joinConversation() / the DM id usually
   * already supply it.
   */
  public onTypingChange(conversationId: string, cb: (typing: boolean) => void, partnerId?: string): () => void {
    this.attachReconnectListeners();
    const cid = (conversationId || '').trim();
    let entry = this.typingEntries.get(cid);
    if (!entry) {
      entry = {
        conversationId: cid,
        partnerId: this.partnerIdFor(cid, partnerId),
        listeners: new Set(),
        lastNotified: null,
        unsub: null,
        mode: null,
      };
      this.typingEntries.set(cid, entry);
    } else if (partnerId) {
      const p = this.partnerIdFor(cid, partnerId);
      if (p && p !== entry.partnerId) {
        entry.partnerId = p;
        if (entry.listeners.size > 0) this.attachTyping(entry);
      }
    }
    entry.listeners.add(cb);
    if (entry.mode === null) this.attachTyping(entry);
    return () => {
      entry!.listeners.delete(cb);
      if (entry!.listeners.size === 0) {
        this.detachTypingUnderlying(entry!);
        this.typingEntries.delete(cid);
      }
    };
  }

  /** Counts for probes — how many subscriptions this hub actually holds. */
  public getTypingDiagnostics(): TypingDiagnostics {
    const docSubs = [...this.typingEntries.values()].filter((e) => e.mode === 'doc').length;
    return {
      conversations: [...this.typingEntries.values()].map((e) => ({
        conversationId: e.conversationId,
        listeners: e.listeners.size,
        mode: e.mode,
        partnerKnown: !!e.partnerId,
      })),
      underlyingSubs: docSubs + (this.collectionUnsub ? 1 : 0),
      collectionSubs: this.collectionUnsub ? 1 : 0,
      openConversations: this.openConversations.size,
    };
  }

  public broadcastUserProfile() {}

  public broadcastPresence(_userId: string, _online: boolean) {}

  public cleanup() {
    this.userId = null;
    try {
      setDeliveredMarkerUser(null);
    } catch { /* intentionally ignored */}
    // C1: the old cleanup left every typing subscription alive after
    // sign-out. Tear the whole hub down — no dangling listeners.
    for (const entry of [...this.typingEntries.values()]) {
      entry.listeners.clear();
      this.detachTypingUnderlying(entry);
    }
    this.typingEntries.clear();
    for (const entry of [...this.recordingEntries.values()]) {
      entry.listeners.clear();
      if (entry.unsub) { try { entry.unsub(); } catch { /* intentionally ignored */} }
    }
    this.recordingEntries.clear();
    this.collectionRecordingEntries.clear();
    if (this.collectionRecordingUnsub) { try { this.collectionRecordingUnsub(); } catch { /* intentionally ignored */} this.collectionRecordingUnsub = null; }
    for (const entry of [...this.typingUsersEntries.values()]) entry.listeners.clear();
    this.typingUsersEntries.clear();
    if (this.typingUsersUnsub) { try { this.typingUsersUnsub(); } catch { /* intentionally ignored */} this.typingUsersUnsub = null; }
    this.openConversations.clear();
    try {
      setPresenceAudience([]);
    } catch { /* intentionally ignored */}
    try {
      setPresenceOpenChats(0);
    } catch { /* intentionally ignored */}
  }

  /** Exposed for screens that want the shared store directly. */
  public get store() {
    return db;
  }
}

export const realtimeSync = new RealtimeSyncService();
