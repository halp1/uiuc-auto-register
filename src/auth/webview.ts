// BrowserSession on top of Bun.WebView (experimental in Bun 1.4).
// Each WebView operation kind has one slot; a second concurrent call throws, so every kind gets its own queue.

import { BrowserError, type BrowserFactory, type BrowserFactoryOptions, type BrowserSession } from "./browser";

class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

const EVALUATE_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, reason: string, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new BrowserError(reason));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class WebViewSession implements BrowserSession {
  readonly backend: "chrome" | "webkit";
  private view: Bun.WebView;
  private navQueue = new Queue();
  private evalQueue = new Queue();
  private inputQueue = new Queue();
  private cdpQueue = new Queue();
  private navigatedOnce = false;
  private isClosed = false;

  constructor(opts: BrowserFactoryOptions) {
    this.backend = opts.backend;
    const backend: Bun.WebView.Backend =
      opts.backend === "webkit"
        ? "webkit"
        : {
            type: "chrome",
            url: false,
            ...(opts.chromePath ? { path: opts.chromePath } : {}),
            // Bun ignores Chromium stderr by default, hiding container sandbox/startup errors.
            stderr: "inherit",
          };
    this.view = new Bun.WebView({
      backend,
      width: opts.width ?? 1280,
      height: opts.height ?? 900,
      dataStore: "ephemeral",
    });
    if (opts.backend === "chrome") {
      this.cdp = <T>(method: string, params?: Record<string, unknown>) => {
        this.assertOpen();
        if (!this.navigatedOnce) return Promise.reject(new BrowserError("cdp_before_navigation"));
        return this.cdpQueue.run(() => this.view.cdp<T>(method, params));
      };
      this.onCdpEvent = (name: string, fn: (params: any) => void) => {
        const listener = (event: Event) => {
          try {
            fn((event as MessageEvent).data);
          } catch (error) {
            console.error("cdp listener failed", error);
          }
        };
        this.view.addEventListener(name, listener);
        return () => this.view.removeEventListener(name, listener);
      };
    }
  }

  cdp?<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onCdpEvent?(name: string, fn: (params: any) => void): () => void;

  get closed(): boolean {
    return this.isClosed;
  }

  private assertOpen() {
    if (this.isClosed) throw new BrowserError("closed");
  }

  url(): string {
    if (this.isClosed) return "";
    try {
      return this.view.url;
    } catch {
      return "";
    }
  }

  navigate(url: string): Promise<void> {
    this.assertOpen();
    return this.navQueue.run(async () => {
      await withTimeout(this.view.navigate(url), NAVIGATE_TIMEOUT_MS, "navigate_timeout", () => {});
      this.navigatedOnce = true;
    });
  }

  evaluate<T = unknown>(expr: string): Promise<T> {
    this.assertOpen();
    // A hung evaluate would wedge the slot forever, so a timeout closes the view.
    return this.evalQueue.run(() =>
      withTimeout(this.view.evaluate<T>(expr), EVALUATE_TIMEOUT_MS, "evaluate_timeout", () => void this.close()),
    );
  }

  click(selector: string, opts?: { timeoutMs?: number }): Promise<void> {
    this.assertOpen();
    return this.inputQueue.run(() => this.view.click(selector, { timeout: opts?.timeoutMs ?? 5000 }));
  }

  type(text: string): Promise<void> {
    this.assertOpen();
    return this.inputQueue.run(() => this.view.type(text));
  }

  press(key: string): Promise<void> {
    this.assertOpen();
    return this.inputQueue.run(() => this.view.press(key));
  }

  async waitFor(predicateExpr: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (signal?.aborted) throw signal.reason;
      this.assertOpen();
      try {
        if (await this.evaluate<boolean>(`Boolean(${predicateExpr})`)) return true;
      } catch (error) {
        if (error instanceof BrowserError) throw error;
        // Page navigating; retry.
      }
      await Bun.sleep(250);
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this.view.close();
    } catch {
      // already closed
    }
  }
}

export const webViewFactory: BrowserFactory = async opts => {
  if (typeof Bun === "undefined" || typeof (Bun as any).WebView !== "function") throw new BrowserError("webview_unavailable");
  const session = new WebViewSession(opts);
  // Establish the page (and the CDP session on chrome) before anyone uses it.
  await session.navigate("about:blank");
  return session;
};
