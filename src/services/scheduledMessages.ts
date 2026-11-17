/**
 * Feature 4d — Scheduled messages (Phase 2).
 *
 * Server-backed as far as the existing AppSync database allows — no
 * `src/aws/*` change, no new collection type, no backend worker:
 *
 *   users/{uid}/scheduledMessages/{schedId}   (one doc per scheduled message)
 *
 * The generic `putDoc / listDocs / onDocChanged` layer in `database.ts`
 * already stores any collection path as an AWSJSON blob, so a per-user
 * subcollection (same pattern as `users/{uid}/starred` in ChatScreen) needs
 * no schema change. Per-user — not a top-level `scheduledMessages`
 * collection — so one user never downloads or sees another user's queue
 * (`database.ts` loads a whole collection on subscribe).
 *
 * How it works:
 *  - `schedule()` writes the doc to the server first. Only if that write
 *    throws (offline / hybrid local mode) is the item kept in the legacy
 *    localStorage queue (`dtscheduled`, same key the old ChatScreen code
 *    used) and marked `localOnly`.
 *  - A single global scheduler, started from `App.tsx` on login, owns one
 *    `onSnapshot` subscription to the user's queue plus a 5 s tick. It fires
 *    while the app is open on ANY screen — the old code only ran a
 *    `setInterval` inside ChatScreen, so a message only sent while that
 *    exact chat was open. The old interval is deleted by PATCH.md.
 *  - Sending writes a normal message doc to `chats/{conversationId}/messages`
 *    via `addDoc`, exactly like `handleSend` in ChatScreen (same fields,
 *    same `serverTimestamp()`), then marks the scheduled doc `sent` and
 *    deletes it. `realtimeSync.sendMessage` is called for 1:1 chats for
 *    parity with `handleSend` (currently a no-op: delivery is via the
 *    AppSync subscription).
 *  - Dedup / crash safety: an item is claimed (`status: 'sending'`,
 *    `claimedAt`) before the message write, and the in-memory `inFlight`
 *    set stops a second tick / snapshot event sending the same item twice.
 *    A `sending` claim older than 60 s is reclaimed (crashed tab). After
 *    the message write the doc is marked `sent` before deletion, so a
 *    crash in that window leaves a `sent` doc that is cleaned up, not
 *    re-sent. Retries stop after 3 failed attempts (`status: 'failed'`,
 *    kept visible so the user can cancel it instead of it retrying forever).
 *  - Legacy local items are uploaded to the server once on login, using
 *    the same doc id, so the upload is idempotent and cannot duplicate.
 *
 * What this does NOT do (needs a backend worker, out of scope):
 *  - Nothing is sent while the app is closed, killed, or the device is
 *    off. There is no Lambda / EventBridge Scheduler / CloudWatch trigger
 *    in this repo (no `amplify/` backend), and the web app cannot run code
 *    while closed. Cross-device delivery also only happens if another
 *    device has the app open while logged in as the same user. See
 *    PATCH.md "Limitations" for what that worker would look like.
 */

import {
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  db,
} from '../aws';
import { realtimeSync, partnerIdForConversation, cleanId } from './realtimeSync';

export type ScheduledMessageStatus = 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';

export interface ScheduledMessage {
  id: string;
  conversationId: string;
  /** Partner uid (1:1) or group/community id — needed for realtime parity. */
  chatId: string;
  isCommunity: boolean;
  text: string;
  /** Epoch ms when the message must be sent. */
  sendAt: number;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  status: ScheduledMessageStatus;
  createdAt: number;
  /** Set when the server write failed and the item lives only in localStorage. */
  localOnly?: boolean;
  attempts?: number;
  lastError?: string;
  claimedAt?: number;
  sentMessageId?: number | string;
}

/** Legacy local-only queue key, kept so old items are not lost (see migrate). */
export const LEGACY_LOCAL_KEY = 'dtscheduled';

export const MAX_SCHEDULED_TEXT = 5000;
const TICK_MS = 5000;
const CLAIM_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;

const newScheduledId = (): string =>
  'sched_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

/** Sort by due time so the modal and the sweep both read oldest-first. */
const bySendAt = (a: ScheduledMessage, b: ScheduledMessage) => a.sendAt - b.sendAt;

type Listener = (items: ScheduledMessage[]) => void;

class ScheduledMessagesService {
  private userId: string | null = null;
  private userProfile: any = null;
  private started = false;
  private timer: any = null;
  private unsub: (() => void) | null = null;
  /** Server-backed items, by id (from the onSnapshot subscription). */
  private serverItems = new Map<string, ScheduledMessage>();
  /** Items that only exist in localStorage (offline scheduling). */
  private localItems = new Map<string, ScheduledMessage>();
  private listeners = new Set<Listener>();
  /** Ids currently being sent — stops overlapping ticks / snapshot events. */
  private inFlight = new Set<string>();
  private sweeping = false;
  private migratedLocal = false;

  private colPath(): string {
    return `users/${this.userId}/scheduledMessages`;
  }

  private senderFields() {
    const u = this.userProfile;
    return {
      senderId: this.userId || '',
      senderName: u?.displayName || u?.username || 'User',
      senderAvatar: u?.photoURL || '',
    };
  }

  // ── Lifecycle (called from App.tsx) ──────────────────────────────────────

  /** Start the global scheduler for this user. Idempotent for the same uid. */
  public init(userId: string, userProfile?: any) {
    if (this.started && this.userId === userId) {
      if (userProfile) this.userProfile = userProfile;
      return;
    }
    this.stop();
    this.userId = userId;
    this.userProfile = userProfile || null;
    this.started = true;
    this.migratedLocal = false;
    this.serverItems.clear();
    this.localItems.clear();
    this.inFlight.clear();

    // Live queue: subscription + database.ts 3 s poll fallback keep this
    // fresh while the app is open, on any screen.
    this.unsub = onSnapshot(collection(db, this.colPath()), (snap: any) => {
      const next = new Map<string, ScheduledMessage>();
      for (const d of snap?.docs || []) {
        const data = d.data();
        if (data && data.id) next.set(data.id, { ...data, localOnly: false });
      }
      this.serverItems = next;
      this.emit();
      void this.processDue();
    });

    this.timer = setInterval(() => void this.processDue(), TICK_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
    }
    // Upload any pre-4d localStorage items, then sweep (some may be due).
    void this.migrateLegacyLocal().finally(() => void this.processDue());
  }

  /** Stop the timer + subscription (sign-out / account switch). */
  public stop() {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.unsub) {
      try {
        this.unsub();
      } catch (err) {
        console.warn("[scheduledMessages] stop: this.unsub() failed", err);
      }
      this.unsub = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
    }
    this.userId = null;
    this.userProfile = null;
    this.serverItems.clear();
    this.localItems.clear();
    this.inFlight.clear();
  }

  public cleanup() {
    this.stop();
  }

  private onVisible = () => {
    // Background tabs throttle setInterval; sweep as soon as we are visible.
    if (!document.hidden) void this.processDue();
  };

  private onOnline = () => {
    void this.migrateLegacyLocal().finally(() => void this.processDue());
  };

  // ── Reading ─────────────────────────────────────────────────────────────

  /** All known items (server wins on id clash), oldest due first. */
  public getAll(): ScheduledMessage[] {
    const merged = new Map(this.serverItems);
    for (const [id, item] of this.localItems) {
      if (!merged.has(id)) merged.set(id, item);
    }
    return [...merged.values()].sort(bySendAt);
  }

  public getPending(conversationId?: string): ScheduledMessage[] {
    return this.getAll().filter(
      (s) =>
        s.status !== 'sent' &&
        s.status !== 'cancelled' &&
        (!conversationId || s.conversationId === conversationId),
    );
  }

  /** Subscribe to the queue; the callback fires immediately with current items. */
  public subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.getAll());
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    const items = this.getAll();
    for (const cb of [...this.listeners]) {
      try {
        cb(items);
      } catch (e) {
        console.warn('Scheduled messages listener error:', e);
      }
    }
  }

  // ── Scheduling / cancelling ─────────────────────────────────────────────

  public async schedule(input: {
    conversationId: string;
    chatId: string;
    isCommunity: boolean;
    text: string;
    sendAt: number;
  }): Promise<{ item: ScheduledMessage; stored: 'server' | 'local' }> {
    const text = (input.text || '').trim();
    if (!text) throw new Error('Empty message');
    if (text.length > MAX_SCHEDULED_TEXT) throw new Error('Message too long (max 5,000 characters)');
    if (!input.conversationId) throw new Error('No conversation');
    if (!this.userId) throw new Error('Not signed in');
    if (input.sendAt <= Date.now() + 5000) throw new Error('Pick a future time');

    const item: ScheduledMessage = {
      id: newScheduledId(),
      conversationId: input.conversationId,
      chatId: input.chatId,
      isCommunity: input.isCommunity,
      text,
      sendAt: input.sendAt,
      ...this.senderFields(),
      status: 'pending',
      createdAt: Date.now(),
      attempts: 0,
    };

    try {
      await setDoc(doc(db, this.colPath(), item.id), { ...item, localOnly: false });
      this.serverItems.set(item.id, { ...item, localOnly: false });
      this.emit();
      return { item, stored: 'server' };
    } catch (e) {
      // Offline / hybrid local mode: keep it on this device instead of
      // losing it. It is uploaded (same id) on the next online sweep.
      const localItem = { ...item, localOnly: true, lastError: String((e as any)?.message || e) };
      this.localItems.set(item.id, localItem);
      this.saveLocal();
      this.emit();
      return { item: localItem, stored: 'local' };
    }
  }

  public async cancel(id: string): Promise<void> {
    this.localItems.delete(id);
    this.saveLocal();
    this.serverItems.delete(id);
    this.emit();
    if (!this.userId) return;
    try {
      await deleteDoc(doc(db, this.colPath(), id));
    } catch (err) {
      // Already gone on the server (e.g. just sent); local state is already clear.
      console.warn("[scheduledMessages] cancel: await deleteDoc(doc(db, this.colPath(), id)) failed", err);
    }
  }

  // ── Local fallback (legacy `dtscheduled` queue) ─────────────────────────

  private loadLocalRaw(): any[] {
    try {
      const raw = localStorage.getItem(LEGACY_LOCAL_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveLocal() {
    try {
      // Preserve items owned by another account on this device: they stay
      // in storage until their owner signs in and migrates them. Only this
      // user's items are replaced (this map only ever holds this user's).
      const raw = this.loadLocalRaw();
      const others = raw.filter((r) => r && r.senderId && r.senderId !== this.userId);
      const all = [...others, ...this.localItems.values()];
      if (all.length === 0) localStorage.removeItem(LEGACY_LOCAL_KEY);
      else localStorage.setItem(LEGACY_LOCAL_KEY, JSON.stringify(all));
    } catch (err) {
      console.warn("[scheduledMessages] saveLocal: const raw = this.loadLocalRaw() failed", err);
    }
  }

  private removeLocal(id: string) {
    if (!this.localItems.has(id)) return;
    this.localItems.delete(id);
    this.saveLocal();
  }

  /**
   * One-time upload of pre-4d / offline local items to the server, using
   * the same doc id so a second run cannot duplicate them. Items that
   * still fail to upload stay local and keep working via the tick below.
   * Legacy items have no sender/status fields; they are filled in here.
   */
  public async migrateLegacyLocal(): Promise<void> {
    if (!this.userId || this.migratedLocal) return;
    this.migratedLocal = true;
    const raw = this.loadLocalRaw();
    if (raw.length === 0) return;
    for (const r of raw) {
      if (!r || !r.id || !r.conversationId || !r.text || !r.sendAt) continue;
      // Owned by a different account on this device: leave it in storage
      // untouched; it migrates when its owner signs in. (Pre-4d items have
      // no senderId and are assumed to belong to the current user.)
      if (r.senderId && r.senderId !== this.userId) continue;
      if (this.serverItems.has(r.id)) {
        this.removeLocal(r.id);
        continue;
      }
      const item: ScheduledMessage = {
        id: String(r.id),
        conversationId: String(r.conversationId),
        chatId: String(r.chatId || ''),
        isCommunity: Boolean(r.isCommunity),
        text: String(r.text),
        sendAt: Number(r.sendAt),
        ...this.senderFields(),
        ...(r.senderId ? { senderId: String(r.senderId) } : {}),
        ...(r.senderName ? { senderName: String(r.senderName) } : {}),
        ...(r.senderAvatar ? { senderAvatar: String(r.senderAvatar) } : {}),
        status: r.status === 'failed' ? 'failed' : 'pending',
        createdAt: Number(r.createdAt) || Number(r.sendAt),
        attempts: Number(r.attempts) || 0,
      };
      try {
        await setDoc(doc(db, this.colPath(), item.id), { ...item, localOnly: false });
        this.serverItems.set(item.id, { ...item, localOnly: false });
        this.removeLocal(item.id);
      } catch {
        this.localItems.set(item.id, { ...item, localOnly: true });
      }
    }
    this.saveLocal();
    this.emit();
  }

  // ── The sweep: send everything due ──────────────────────────────────────

  public async processDue(): Promise<void> {
    if (!this.started || !this.userId || this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      const due = this.getAll().filter((s) => {
        if (s.status === 'sent' || s.status === 'cancelled') return false;
        if (s.status === 'failed') return false;
        if (s.status === 'sending') {
          // Stale claim (tab crashed mid-send): reclaim it. A fresh claim
          // means another tab / this sweep is already sending it.
          return now - (s.claimedAt || 0) > CLAIM_LEASE_MS;
        }
        return s.sendAt <= now;
      });
      if (due.length === 0) {
        // Clean up any `sent` docs left behind by a crash after marking.
        for (const s of this.getAll()) {
          if (s.status === 'sent' && !s.localOnly) {
            try {
              await deleteDoc(doc(db, this.colPath(), s.id));
            } catch (err) {
              console.warn("[scheduledMessages] processDue: await deleteDoc(doc(db, this.colPath(), s.id)...", err);
            }
            this.serverItems.delete(s.id);
          }
        }
        return;
      }
      for (const item of due) {
        await this.sendOne(item);
      }
      this.emit();
    } finally {
      this.sweeping = false;
    }
  }

  private async sendOne(item: ScheduledMessage): Promise<void> {
    if (this.inFlight.has(item.id)) return;
    // Phase 3 — block enforcement: never send a scheduled message to a
    // chat the user has since blocked. The item is marked failed with a
    // clear reason (visible in the scheduled list) instead of being sent.
    if (this.userId && !item.isCommunity) {
      try {
        const snap = await getDoc(doc(db, 'users', this.userId));
        const blocked: any[] = (snap.exists() && Array.isArray(snap.data().blockedUsers))
          ? snap.data().blockedUsers
          : [];
        // Phase 5 (L-16): never auto-send a scheduled message into a
        // locked chat — the lock means "do not surface this conversation".
        // Same inline failure update as the blocked branch below (there is
        // no markFailed helper in this file).
        // 100M-S3: hidden/blocked hold PARTNER uids, but item.chatId and
        // item.conversationId are conv ids in the conv-id shape — a direct
        // includes() missed the gate and the message sailed through to the
        // encryption failure (and would send in production with a real
        // agreed key). Derive the partner from each id, same as the
        // screens do.
        const lockedMod = await import('./lockedChats').catch(() => null);
        const hidden: string[] = lockedMod ? await lockedMod.loadHiddenChatIds(this.userId!).catch(() => []) : [];
        const hiddenSet = new Set(hidden.map(String));
        const isLockedId = (id: string) =>
          hidden.includes(id) ||
          (lockedMod ? lockedMod.isLockedConversation(id, this.userId!, hiddenSet) : false);
        if (isLockedId(item.chatId) || isLockedId(item.conversationId)) {
          const lastError = 'Recipient is in a locked chat — scheduled message not sent.';
          const next: ScheduledMessage = { ...item, status: 'failed', attempts: (item.attempts || 0) + 1, lastError };
          if (!item.localOnly && this.serverItems.has(item.id)) {
            try {
              await updateDoc(doc(db, this.colPath(), item.id), { status: 'failed', attempts: next.attempts, lastError });
            } catch (err) {
              console.warn("[scheduledMessages] sendOne: await updateDoc(doc(db, this.colPath(), item.id)...", err);
            }
            this.serverItems.set(item.id, next);
          } else {
            this.localItems.set(item.id, next);
            this.saveLocal();
          }
          console.warn('Scheduled message skipped (locked chat):', item.id);
          return;
        }
        // 100M-S3: same conv-id miss on the blocked gate — derive the
        // partner from each id. The derived partner is in cleaned form
        // (dashes → underscores for real Cognito UUIDs) while blocked
        // holds raw user-doc uids, so match either form.
        const blockedPartner = (id: string): boolean => {
          const p = partnerIdForConversation(id, this.userId);
          if (!p) return false;
          return blocked.some((b) => String(b) === p || cleanId(String(b)) === p);
        };
        if (blocked.includes(item.chatId) || blocked.includes(item.conversationId) || blockedPartner(item.chatId) || blockedPartner(item.conversationId)) {
          const lastError = 'Recipient is blocked — scheduled message not sent.';
          const next: ScheduledMessage = { ...item, status: 'failed', attempts: (item.attempts || 0) + 1, lastError };
          if (!item.localOnly && this.serverItems.has(item.id)) {
            try {
              await updateDoc(doc(db, this.colPath(), item.id), { status: 'failed', attempts: next.attempts, lastError });
            } catch (err) {
              console.warn("[scheduledMessages] sendOne: await updateDoc(doc(db, this.colPath(), item.id)...", err);
            }
            this.serverItems.set(item.id, next);
          } else {
            this.localItems.set(item.id, next);
            this.saveLocal();
          }
          console.warn('Scheduled message skipped (blocked chat):', item.id);
          return;
        }
      } catch (err) {
        // Block-list read failed: fall through and send (fail open — the
        // block check is best-effort, not a reason to lose the message).
        console.warn("[scheduledMessages] sendOne: const snap = await getDoc(doc(db, 'users', this....", err);
      }
    }
    this.inFlight.add(item.id);
    const serverBacked = !item.localOnly && this.serverItems.has(item.id);
    try {
      // 1. Claim first — a second open tab sees `sending` and skips it.
      if (serverBacked) {
        await updateDoc(doc(db, this.colPath(), item.id), {
          status: 'sending',
          claimedAt: Date.now(),
        });
        this.serverItems.set(item.id, { ...item, status: 'sending', claimedAt: Date.now() });
      }

      // 2. Send exactly like ChatScreen.handleSend (same fields / collection).
      const senderName = item.senderName || this.senderFields().senderName;
      const senderAvatar = item.senderAvatar || this.senderFields().senderAvatar;
      const ref = await addDoc(collection(db, 'chats', item.conversationId, 'messages'), {
        text: item.text,
        senderId: item.senderId,
        senderName,
        senderAvatar,
        timestamp: serverTimestamp(),
        status: 'sent',
      });
      if (!item.isCommunity && item.chatId) {
        realtimeSync.sendMessage(item.chatId, {
          conversationId: item.conversationId,
          senderId: item.senderId,
          senderName,
          senderAvatar,
          text: item.text,
          timestamp: Date.now(),
        });
      }

      // 3. Mark sent BEFORE deleting: a crash here leaves a `sent` doc that
      // processDue() cleans up instead of re-sending the message.
      if (serverBacked) {
        try {
          await updateDoc(doc(db, this.colPath(), item.id), {
            status: 'sent',
            sentMessageId: ref.id,
          });
        } catch (err) {
          console.warn("[scheduledMessages] sendOne: await updateDoc(doc(db, this.colPath(), item.id)...", err);
        }
        try {
          await deleteDoc(doc(db, this.colPath(), item.id));
        } catch (err) {
          console.warn("[scheduledMessages] sendOne: await deleteDoc(doc(db, this.colPath(), item.id)...", err);
        }
        this.serverItems.delete(item.id);
      }
      this.removeLocal(item.id);
    } catch (e) {
      const attempts = (item.attempts || 0) + 1;
      const lastError = String((e as any)?.message || e);
      const failed = attempts >= MAX_ATTEMPTS;
      const next: ScheduledMessage = {
        ...item,
        status: failed ? 'failed' : 'pending',
        attempts,
        lastError,
        claimedAt: undefined,
      };
      if (serverBacked) {
        try {
          await updateDoc(doc(db, this.colPath(), item.id), {
            status: next.status,
            attempts,
            lastError,
            claimedAt: null,
          });
        } catch (err) {
          console.warn("[scheduledMessages] sendOne: await updateDoc(doc(db, this.colPath(), item.id)...", err);
        }
        this.serverItems.set(item.id, next);
      } else {
        this.localItems.set(item.id, next);
        this.saveLocal();
      }
      console.error('Scheduled message failed:', item.id, lastError);
    } finally {
      this.inFlight.delete(item.id);
    }
  }
}

export const scheduledMessages = new ScheduledMessagesService();
