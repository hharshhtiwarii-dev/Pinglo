/**
 * Error boundary (Phase 3, Agent C): one render error in a screen must not
 * blank the whole app. Wrap the root in main.tsx; a crash shows a reload
 * prompt instead of a white screen, and the error is logged for diagnosis.
 *
 * NOTE on types: this project has no `@types/react` installed and React
 * 19's package here ships no `.d.ts`, so `React.Component` has no type
 * declarations and a normal `extends Component` fails `tsc`. This file
 * therefore uses a tiny structural class-component base: React recognises
 * a class component by the `isReactComponent` marker on its prototype
 * (and injects `updater` at mount, which setState delegates to), so the
 * boundary works at runtime exactly like one extending React.Component.
 * If `@types/react` is ever added, this file should be switched to
 * `extends Component` from 'react'.
 */

interface ErrorBoundaryProps {
  children?: unknown;
  /** Optional custom fallback UI. Defaults to a plain reload screen. */
  fallback?: unknown;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error | null;
  /** A chunk-load auto-reload is scheduled — the UI says so honestly. */
  autoReloading?: boolean;
}

/** True when the error is a failed dynamic import (chunk-load failure). */
export function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /Failed to fetch dynamically imported module|Loading chunk|Importing a module script failed|Failed to load module script/i.test(msg);
}

/** Minimal class-component base (see header note). */
class ClassComponent<P extends object = Record<string, unknown>, S extends object = Record<string, unknown>> {
  props: P;
  state: S;
  // Set by the React reconciler at mount; setState delegates to it.
  updater?: {
    enqueueSetState: (instance: unknown, partial: unknown, callback?: () => void) => void;
  };

  constructor(props: P) {
    this.props = props;
    this.state = {} as S;
  }

  setState(partial: Partial<S> | ((prev: S) => Partial<S>), callback?: () => void): void {
    if (this.updater) {
      this.updater.enqueueSetState(this, partial, callback);
    } else {
      const next = typeof partial === 'function' ? (partial as (s: S) => Partial<S>)(this.state) : partial;
      this.state = { ...this.state, ...next };
      if (callback) callback();
    }
  }
}
((ClassComponent.prototype as unknown) as Record<string, unknown>).isReactComponent = {};

export class ErrorBoundary extends ClassComponent<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, autoReloading: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error, autoReloading: false };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    console.error('Pinglo render error caught by ErrorBoundary:', error, info);
    // RETEST-1: a chunk-load failure is almost always transient — flaky
    // network, a loaded host, or a stale chunk after an app update. A
    // dead "couldn't be opened" screen is the wrong outcome for it, so
    // auto-reload after a short delay; the user sees a brief hiccup
    // instead of a stuck screen. Up to 5 auto-reloads: one wasn't enough
    // — a host pressure wave outlasted the lazy retries AND the single
    // reload, leaving the chat dead until a manual Reload. The counter
    // resets after 2 quiet minutes, so a genuinely missing chunk still
    // settles on the fallback (with its manual Reload button) instead
    // of looping forever.
    // REPORT-3 #248 (W13 NEXT R4): the delay is 800ms (was 2500ms) and
    // the cap is 5 (was 3) — the lazy retry loop now fails FAST on a
    // poisoned module map (see App.tsx lazyWithRetry), so the boundary
    // fires within ~1s of the failure and the reload is the recovery.
    // A reload clears the browser's module map, which is the only thing
    // that can un-poison a chunk. The fallback below says "Retrying…"
    // while a reload is pending, so the user never stares at a dead
    // screen wondering what happened.
    if (isChunkLoadError(error)) {
      try {
        const now = Date.now();
        const last = Number(sessionStorage.getItem('dtc-chunk-reload-at') || 0);
        let count = Number(sessionStorage.getItem('dtc-chunk-reload-count') || 0);
        if (now - last > 120_000) count = 0;
        if (count < 5) {
          sessionStorage.setItem('dtc-chunk-reload-at', String(now));
          sessionStorage.setItem('dtc-chunk-reload-count', String(count + 1));
          this.setState({ autoReloading: true });
          setTimeout(() => window.location.reload(), 800);
        }
      } catch { /* intentionally ignored */}
    }
  }

  private handleReload = () => {
    try {
      window.location.reload();
    } catch { /* intentionally ignored */}
  };

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render(): unknown {
    if (!this.state.hasError) return this.props.children;
    // A fallback may be a render-prop receiving the boundary state, so a
    // scoped fallback can say "Retrying automatically…" while a reload is
    // pending instead of a static message. Plain elements render as-is.
    if (this.props.fallback) {
      if (typeof this.props.fallback === 'function') {
        return (this.props.fallback as (s: { error: Error | null; autoReloading: boolean }) => unknown)({
          error: this.state.error ?? null,
          autoReloading: !!this.state.autoReloading,
        });
      }
      return this.props.fallback;
    }
    // REPORT-3 #248: a chunk-load failure is a loading failure, not a
    // crash — say so, and say what is happening. "Try again" is hidden
    // for chunk errors: resetting the boundary re-renders the same lazy
    // component, which re-throws the browser's CACHED module-map error
    // instantly — it can never recover without a reload, so offering it
    // would be a dead button.
    const chunkErr = isChunkLoadError(this.state.error);
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-[#0B141A] gap-4 px-6 text-center">
        <h1 className="text-xl font-bold text-white">{chunkErr ? "Couldn't load this screen" : 'Something went wrong'}</h1>
        <p className="text-sm text-gray-400">
          {chunkErr
            ? this.state.autoReloading
              ? 'Your connection dropped a file while loading. Retrying automatically…'
              : 'Your connection dropped a file while loading. Your chats are safe — try reloading.'
            : 'Pinglo hit an unexpected error. Your chats are safe — try reloading.'}
        </p>
        <div className="flex gap-3">
          <button
            onClick={this.handleReload}
            className="px-4 py-2 rounded-full bg-[#25D366] text-white text-sm font-semibold"
          >
            Reload app
          </button>
          {!chunkErr && (
            <button
              onClick={this.handleReset}
              className="px-4 py-2 rounded-full bg-gray-700 text-white text-sm"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
