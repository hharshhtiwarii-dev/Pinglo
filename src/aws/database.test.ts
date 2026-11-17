// Tests for the persisted-cache key parser behind the H7 Storage Usage
// fix (see parsePersistedChatChannelId in ./database.ts). The whole fix
// rests on this regex: if the key format ever changes, the parser returns
// null for every key, listPersistedChatChannels() returns [] and Storage
// Usage shows 0 again on a fresh load — exactly the H7 bug.
//
// NOTE (runner pending): the repo has no test runner yet (no `test` script
// in package.json, no *.test.* files before this one). These tests are
// written in Vitest style (the natural runner for this Vite repo) so they
// run as soon as the runner lands. Do NOT add the runner here — a sibling
// worker owns it. The parser logic itself was verified headless via a
// node/esbuild mock run (see the audit report) until then.
//
// The @ts-ignore below is the bridge until that lands: `vitest` is not
// installed yet, so without it `npm run lint` (tsc --noEmit) fails on this
// import. Delete the @ts-ignore line when the runner (and vitest) lands —
// the import itself stays as-is.
// @ts-ignore - vitest not installed yet; runner sibling owns it.
import { describe, it, expect } from 'vitest';
import { parsePersistedChatChannelId } from './database';

describe('parsePersistedChatChannelId', () => {
  it('parses a plain chat messages key', () => {
    expect(parsePersistedChatChannelId('chats/abc123/messages')).toBe('abc123');
  });

  it('parses ids with dashes and underscores', () => {
    expect(parsePersistedChatChannelId('chats/usr_fb943701-bebb-4523/messages')).toBe(
      'usr_fb943701-bebb-4523',
    );
  });

  it('parses a twin-collection case: two chat keys give two ids', () => {
    const keys = ['chats/chat-a/messages', 'chats/chat-b/messages'];
    expect(keys.map(parsePersistedChatChannelId)).toEqual(['chat-a', 'chat-b']);
  });

  it('excludes saved_ channels', () => {
    expect(parsePersistedChatChannelId('chats/saved_usr1/messages')).toBeNull();
  });

  it('rejects keys that are not a chat messages collection', () => {
    expect(parsePersistedChatChannelId('chats')).toBeNull();
    expect(parsePersistedChatChannelId('chats/abc123')).toBeNull();
    expect(parsePersistedChatChannelId('chats/abc123/messages/extra')).toBeNull();
    expect(parsePersistedChatChannelId('chats/abc123/drafts')).toBeNull();
    expect(parsePersistedChatChannelId('users/abc123')).toBeNull();
    expect(parsePersistedChatChannelId('calls')).toBeNull();
    expect(parsePersistedChatChannelId('chats//messages')).toBeNull();
  });

  it('rejects non-string and empty keys', () => {
    expect(parsePersistedChatChannelId(null)).toBeNull();
    expect(parsePersistedChatChannelId(undefined)).toBeNull();
    expect(parsePersistedChatChannelId(123)).toBeNull();
    expect(parsePersistedChatChannelId('')).toBeNull();
  });
});
