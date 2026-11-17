import { App } from '@capacitor/app';

type BackHandler = () => boolean; // returns true if it handled/consumed the back press

class NavigationBackStack {
  private stack: BackHandler[] = [];
  private lastBackPress = 0;
  private lastPopTime = 0;
  private navigateFn: ((delta: number) => void) | null = null;
  private currentPathname = '/';
  private listenersAttached = false;
  private popstateHandler: ((e: PopStateEvent) => void) | null = null;
  private backButtonHandle: { remove: () => Promise<void> } | null = null;

  constructor() {
    this.setupCapacitorListener();
    this.setupBrowserPopstate();
  }

  public setNavigator(navigate: (delta: number) => void, pathname: string) {
    this.navigateFn = navigate;
    this.currentPathname = pathname;
  }

  public pushHandler(handler: BackHandler): () => void {
    this.stack.push(handler);
    return () => {
      this.stack = this.stack.filter(h => h !== handler);
    };
  }

  public handleBack(): boolean {
    const now = Date.now();

    // 1. Try to pop the top modal / drawer / lightbox handler
    while (this.stack.length > 0) {
      const handler = this.stack.pop();
      if (handler) {
        try {
          const handled = handler();
          if (handled) return true;
        } catch (e) {
          console.warn('Back handler error:', e);
        }
      }
    }

    // 2. If no modal open, check if we can navigate back in-app (with 250ms debounce)
    const isRoot = this.currentPathname === '/main' || this.currentPathname === '/login' || this.currentPathname === '/';
    if (!isRoot && this.navigateFn) {
      if (now - this.lastPopTime < 250) return true; // Throttle rapid-fire back taps
      this.lastPopTime = now;
      this.navigateFn(-1);
      return true;
    }

    // 3. At root screen: double-tap to exit guard
    if (now - this.lastBackPress < 2000) {
      App.exitApp().catch(() => {});
      return true;
    }
    this.lastBackPress = now;
    this.showToast('Press back again to exit');
    return false;
  }

  private setupCapacitorListener() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    try {
      // App.addListener resolves to a handle with remove() — keep it so
      // dispose() can detach the native back-button listener.
      const maybeHandle: any = App.addListener('backButton', () => {
        this.handleBack();
      });
      if (maybeHandle && typeof maybeHandle.then === 'function') {
        maybeHandle.then((h: any) => {
          this.backButtonHandle = h;
        }).catch(() => {});
      }
    } catch  { /* intentionally ignored */}
  }

  private setupBrowserPopstate() {
    if (typeof window === 'undefined' || this.popstateHandler) return;
    this.popstateHandler = (e) => {
      if (this.stack.length > 0) {
        e.preventDefault();
        this.handleBack();
        // Push state back so browser history stays intact
        window.history.pushState(null, '', window.location.href);
      }
    };
    window.addEventListener('popstate', this.popstateHandler);
  }

  /** Detach the popstate + native back-button listeners (teardown / tests). Re-attach with setup(). */
  public dispose() {
    if (typeof window !== 'undefined' && this.popstateHandler) {
      window.removeEventListener('popstate', this.popstateHandler);
      this.popstateHandler = null;
    }
    if (this.backButtonHandle) {
      try {
        void this.backButtonHandle.remove().catch(() => {});
      } catch { /* intentionally ignored */}
      this.backButtonHandle = null;
    }
    this.listenersAttached = false;
  }

  /** Re-attach listeners after dispose() (no-op if already attached). */
  public setup() {
    this.setupCapacitorListener();
    this.setupBrowserPopstate();
  }

  private showToast(msg: string) {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById('pinglo-back-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'pinglo-back-toast';
    toast.innerText = msg;
    toast.style.position = 'fixed';
    toast.style.bottom = '80px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = '#1F2C34';
    toast.style.color = '#FFFFFF';
    toast.style.padding = '8px 16px';
    toast.style.borderRadius = '20px';
    toast.style.fontSize = '13px';
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
    toast.style.zIndex = '99999';
    toast.style.pointerEvents = 'none';
    toast.style.transition = 'opacity 0.3s ease';

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 1800);
  }
}

export const navigationManager = new NavigationBackStack();
