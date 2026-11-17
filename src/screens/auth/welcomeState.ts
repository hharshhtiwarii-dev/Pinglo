// REPORT-3 #132 (W13 NEXT R3): welcome-seen flag lives in its own tiny
// module so App.tsx can read it WITHOUT statically importing the whole
// WelcomeScreen (which used to drag the screen into the entry chunk —
// the first paint then waited on JS the launch screen never needs).
const SEEN_KEY = 'pinglo_welcome_seen';

export function hasSeenWelcome(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch (_) {
    /* private mode — the welcome screen just shows again next launch */
  }
}
