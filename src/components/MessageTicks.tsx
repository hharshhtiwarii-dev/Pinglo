import React from 'react';

/**
 * WhatsApp-style delivery ticks.
 *  - pending:   a clock icon (WA's not-yet-sent state — Wave-2 A5, DM #41).
 *                Shown while a message is still uploading / queued; the
 *                message has no delivery state yet, so no tick is drawn.
 *  - sent:      one grey tick
 *  - delivered: two grey ticks
 *  - seen:      two blue ticks
 * The second tick draws in smoothly when the message is delivered.
 */

const GREY = 'var(--chat-tick-grey, #8696a0)';
// Seen-tick blue comes from the theme var (--chat-tick), so a custom theme
// recolours the ticks too; #53bdeb is the Classic Pro default fallback.
// --chat-tick is WhatsApp's exact #007BFC in light mode (3.62:1 on
// #D9FDD3, measured) and #53BDEB in dark mode (4.59:1 on #144D37);
// --chat-tick-grey follows WhatsApp's alpha model: rgba(0,0,0,.6)
// light (5.58:1 blended on #D9FDD3) / rgba(255,255,255,.6) dark
// (4.65:1 blended on #144D37). The blue-vs-grey distinction (seen vs
// delivered) is kept.

interface MessageTicksProps {
  status?: string;
}

export default function MessageTicks({ status }: MessageTicksProps) {
  // Wave-2 A5 (DM #41): 'pending' / 'queued' = not yet sent — WA shows a
  // clock icon, not a tick. Same grey as an unsent tick.
  if (status === 'pending' || status === 'queued') {
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        role="img"
        aria-label="Sending"
        data-pending-clock
        className="inline-block shrink-0 align-middle"
      >
        <title>Sending…</title>
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke={GREY}
          strokeWidth={1.6}
        />
        <path
          d="M8 4.5 V8 L10.5 9.5"
          fill="none"
          stroke={GREY}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  const seen = status === 'seen';
  const delivered = status === 'delivered' || seen;
  const color = seen ? 'var(--chat-tick, #53bdeb)' : GREY;
  const label = seen ? 'Seen' : delivered ? 'Delivered' : 'Sent';

  const tickPath = 'M1 5.5 L4.5 9 L11 2';
  const secondPath = 'M5 5.5 L8.5 9 L15 2';

  return (
    <svg
      width="16"
      height="11"
      viewBox="0 0 16 11"
      role="img"
      aria-label={label}
      className="inline-block shrink-0 align-middle"
    >
      <title>{label}</title>
      <path
        d={tickPath}
        pathLength={1}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ transition: 'stroke 250ms ease' }}
      />
      <path
        d={secondPath}
        pathLength={1}
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={1}
        strokeDashoffset={delivered ? 0 : 1}
        style={{ transition: 'stroke-dashoffset 300ms ease, stroke 250ms ease' }}
      />
    </svg>
  );
}
