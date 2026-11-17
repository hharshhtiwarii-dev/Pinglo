import React from 'react';

/**
 * Segmented status ring (Cluster C, Item 11c).
 *
 * WhatsApp-style: one arc segment per status in the group; segments for
 * statuses the viewer has already seen are dimmed (grey), unviewed ones
 * are green. A single status renders as one full ring (same look as
 * before); zero statuses renders no ring at all.
 *
 * Pure SVG — no new dependency. The avatar itself is passed as `children`
 * and sits inside the ring.
 *
 * WA audit (d):
 *  - S6 — viewed segments use the WA seen token: `#C2BDB8` light /
 *    `#757778` dark, via the `--wa-status-seen` CSS var (index.css),
 *    not the old hardcoded `#9ca3af`.
 *  - S8 — the ring is reused on chat-list avatars (ChatListScreen wraps
 *    DM avatars of contacts with unviewed status in this component).
 *  - S9 — Close Friends statuses ring purple `#C15ADD` (WA token
 *    `--WDS-components-profile-photo-status-ring-close-friends`) for
 *    their unviewed segments; viewed segments stay the seen grey.
 */

interface StatusRingProps {
  /** One entry per status, in order: true = this status has been viewed by me. */
  viewed: boolean[];
  /** Diameter of the whole ring (px). Default 56. */
  size?: number;
  /** Ring thickness (px). Default 2.5. */
  strokeWidth?: number;
  /** Close Friends audience: unviewed segments render purple #C15ADD. */
  closeFriends?: boolean;
  children: React.ReactNode;
}

export default function StatusRing({ viewed, size = 56, strokeWidth = 2.5, closeFriends = false, children }: StatusRingProps) {
  const n = viewed.length;
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const gap = n > 1 ? 3 : 0; // px gap between segments
  const segLen = n > 0 ? c / n - gap : 0;

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }} aria-label={n > 0 ? `${n} status update${n === 1 ? '' : 's'}${closeFriends ? ' (Close Friends)' : ''}` : undefined}>
      {n > 0 && (
        <svg
          className="absolute inset-0 -rotate-90"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
        >
          {viewed.map((isViewed, i) => (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={isViewed ? 'var(--wa-status-seen, #C2BDB8)' : closeFriends ? '#C15ADD' : '#25d366'}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={`${Math.max(segLen, 0.5)} ${c - Math.max(segLen, 0.5)}`}
              strokeDashoffset={-(i * (c / n))}
            />
          ))}
        </svg>
      )}
      <div className="absolute inset-0 flex items-center justify-center" style={{ padding: strokeWidth + 1.5 }}>
        {children}
      </div>
    </div>
  );
}
