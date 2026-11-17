/**
 * MF-01 — View-once media acceptance tests (SCAFFOLD).
 *
 * Executable with the repo's own toolchain, no new dependency:
 *   npx tsc src/types/viewOnce.ts src/services/__tests__/viewOnce.acceptance.test.ts \
 *     --outDir /tmp/viewonce-test --module nodenext --target es2022 \
 *     --moduleResolution nodenext --skipLibCheck
 *   node --test /tmp/viewonce-test/services/__tests__/viewOnce.acceptance.test.js
 *
 * Pure-rule tests run green on this scaffold. Firestore / native /
 * component tests are `test.skip` — tagged with their rule ID — until
 * the implementing worker wires the Firestore emulator / native bridge
 * / headless render harness. A skipped test is an explicit TODO, not
 * a pass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildViewOnceViewedUpdate,
  isViewOnceOpenable,
  viewOnceViewerHasNoItems,
} from '../../types/viewOnce';

describe('MF-01 view-once (VO-01–VO-05)', () => {
  it('VO-03: viewed-update payload marks viewed:true with a viewedAt stamp', () => {
    const update = buildViewOnceViewedUpdate(1_700_000_000_000);
    assert.equal(update.viewed, true);
    assert.equal(update.viewedAt, 1_700_000_000_000);
  });

  it('VO-01/VO-03: an unviewed view-once image/video message is openable', () => {
    assert.equal(
      isViewOnceOpenable({ isViewOnce: true, mediaUrl: 'https://x/img.jpg', mediaType: 'image', viewed: false }),
      true,
    );
    assert.equal(
      isViewOnceOpenable({ isViewOnce: true, mediaUrl: 'https://x/v.mp4', mediaType: 'video', viewed: false }),
      true,
    );
  });

  it('VO-03: an already-viewed view-once message cannot be re-opened', () => {
    assert.equal(
      isViewOnceOpenable({ isViewOnce: true, mediaUrl: 'https://x/img.jpg', mediaType: 'image', viewed: true }),
      false,
    );
  });

  it('VO-01: a non-view-once message, or one without media, is not openable as view-once', () => {
    assert.equal(
      isViewOnceOpenable({ isViewOnce: false, mediaUrl: 'https://x/img.jpg', mediaType: 'image', viewed: false }),
      false,
    );
    assert.equal(
      isViewOnceOpenable({ isViewOnce: true, mediaUrl: undefined, mediaType: 'image', viewed: false }),
      false,
    );
    // Audio/files are out of view-once v1 scope (photo/video only).
    assert.equal(
      isViewOnceOpenable({ isViewOnce: true, mediaUrl: 'https://x/a.mp3', mediaType: 'audio', viewed: false }),
      false,
    );
  });

  it('VO-02: the viewer state carries no swipeable items list', () => {
    assert.equal(
      viewOnceViewerHasNoItems({
        messageId: 'm1',
        chatId: 'c1',
        mediaUrl: 'https://x/img.jpg',
        mediaType: 'image',
      }),
      true,
    );
  });

  // --- Skipped: need a live seam the scaffold does not provide yet. ---
  it.skip('VO-03: markViewOnceViewed writes viewed:true + viewedAt in ONE updateDoc (needs Firestore emulator)', () => {
    assert.fail('TODO: run against the Firestore emulator with a seeded view-once doc');
  });

  it.skip('VO-03: markViewOnceViewed refuses the sender\'s own message (needs Firestore emulator)', () => {
    assert.fail('TODO: sender preview must never mark the message viewed');
  });

  it.skip('VO-02: ViewOnceViewer renders a canvas and no <img src>, download or share button (needs headless render)', () => {
    assert.fail('TODO: headless-Chrome render assertion on the component DOM');
  });

  it.skip('VO-04: the object URL is revoked when the viewer unmounts (needs headless render)', () => {
    assert.fail('TODO: spy on URL.revokeObjectURL across mount/unmount');
  });

  it.skip('VO-05: FLAG_SECURE is set while the viewer is open (needs Android native bridge + real device)', () => {
    assert.fail('TODO: Capacitor plugin bridge to MainActivity.setViewOnceSecure does not exist yet');
  });
});
