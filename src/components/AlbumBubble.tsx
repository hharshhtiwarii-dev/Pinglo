// ── ROADMAP-2 item 6: albums ─────────────────────────────────────────────
// One grouped bubble for photos/videos sent together (same `albumId`).
// Collapsed: a 2-column grid of up to 4 tiles (3 → one wide tile + two
// below, 4+ → 2×2 with a "+N" overlay on the last tile). Tap the "+N"
// tile or "Show all" to expand to full-width tiles; tap any other tile
// to open it in the lightbox. Tiles carry their own upload state
// (Uploading… % / Upload failed) because each file uploads separately.
// Non-photo/video files never enter a group (see ChatScreen albumGroups).
import React from 'react';

export interface AlbumItem {
  id: string;
  mediaUrl: string;
  mediaType?: string;
  posterUrl?: string;
  uploading?: boolean;
  uploadProgress?: number;
  uploadFailed?: boolean;
  fileName?: string;
  senderName?: string;
  timestamp?: any;
}

interface AlbumBubbleProps {
  items: AlbumItem[];
  expanded: boolean;
  onToggleExpand: () => void;
  onOpen: (item: AlbumItem) => void;
  // WA parity (DM audit row 27): the album's time + ticks, overlaid on
  // the last tile's bottom-right at 11 px like WhatsApp — NOT a separate
  // row below the album.
  meta?: React.ReactNode;
}

const TILE = 'relative overflow-hidden bg-black/10 dark:bg-white/5 cursor-pointer';

export default function AlbumBubble({ items, expanded, onToggleExpand, onOpen, meta }: AlbumBubbleProps) {
  const shown = expanded ? items : items.slice(0, 4);
  const extra = items.length - 4;

  const tileClass = (i: number) => {
    if (expanded) return 'w-full aspect-[4/3]';
    if (items.length === 1) return 'w-full aspect-[4/3]';
    if (items.length === 3 && i === 0) return 'col-span-2 aspect-[16/9]';
    return 'aspect-square';
  };

  return (
    <div data-album="true" data-album-count={items.length} aria-label={`Album of ${items.length} photos`} className="w-full">
      <div className={expanded ? 'flex flex-col gap-1' : 'grid grid-cols-2 gap-1'}>
        {shown.map((item, i) => {
          const isLastCollapsed = !expanded && i === shown.length - 1 && extra > 0;
          return (
            <div
              key={item.id}
              data-album-tile={item.id}
              role="button"
              tabIndex={0}
              aria-label={isLastCollapsed ? `Show ${extra} more photos` : `Open photo ${i + 1} of ${items.length}`}
              onClick={() => { if (isLastCollapsed) onToggleExpand(); else onOpen(item); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { if (isLastCollapsed) onToggleExpand(); else onOpen(item); } }}
              className={`${TILE} ${tileClass(i)}`}
            >
              {item.mediaType === 'video' ? (
                <>
                  <video src={item.mediaUrl} poster={item.posterUrl || undefined} preload="metadata" className="w-full h-full object-cover" />
                  <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white text-sm">▶</span>
                  </span>
                </>
              ) : (
                <img src={item.mediaUrl} alt="" className="w-full h-full object-cover" />
              )}
              {isLastCollapsed && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-white text-xl font-semibold">+{extra}</span>
              )}
              {item.uploading && (
                <span className="absolute inset-x-0 bottom-0 bg-black/55 text-white text-[10px] font-medium text-center py-0.5">
                  Uploading…{typeof item.uploadProgress === 'number' && item.uploadProgress > 0 ? ` ${item.uploadProgress}%` : ''}
                </span>
              )}
              {item.uploadFailed && !item.uploading && (
                <span className="absolute inset-x-0 bottom-0 bg-red-600/85 text-white text-[10px] font-medium text-center py-0.5">Upload failed</span>
              )}
              {meta && i === shown.length - 1 && (
                <span data-bubble-meta data-inline="overlay" data-variant="overlay" className="absolute bottom-1 right-1 inline-flex items-center gap-1 select-none bg-black/55 text-white rounded px-1.5 py-0.5">
                  {meta}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {items.length > 4 && (
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-1 w-full text-center text-[11px] font-medium text-primary-green hover:underline"
        >
          {expanded ? 'Show less' : `Show all ${items.length} photos`}
        </button>
      )}
    </div>
  );
}
