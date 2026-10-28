// Browser abstraction so the login and Banner session code do not depend on one engine.
// WebViewSession (Bun.WebView) implements it today; a Puppeteer adapter could replace it.

export type BrowserBackend = "chrome" | "webkit";

export interface BrowserSession {
  readonly backend: BrowserBackend;
  /** Load a URL. Resolves on the main frame load event. */
  navigate(url: string): Promise<void>;
  /**
   * Evaluate a JavaScript EXPRESSION in the page (wrap statements in an async IIFE).
   * Never interpolate secrets into the expression.
   */
  evaluate<T = unknown>(expr: string): Promise<T>;
  /** Wait for the selector to be actionable and click its center with a native click. */
  click(selector: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Insert text into the focused element (native InsertText). The only way secrets enter a page. */
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  /** Current top-level URL ("" before the first navigation). */
  url(): string;
  /** Poll a boolean expression until true. Resolves false on timeout. */
  waitFor(predicateExpr: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
  readonly closed: boolean;
  /** Raw Chrome DevTools Protocol. Absent on the webkit backend. */
  cdp?<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event. Returns an unsubscribe function. Absent on webkit. */
  onCdpEvent?(name: string, fn: (params: any) => void): () => void;
}

export interface BrowserFactoryOptions {
  backend: BrowserBackend;
  chromePath: string | null;
  width?: number;
  height?: number;
}

export type BrowserFactory = (opts: BrowserFactoryOptions) => Promise<BrowserSession>;

/** Errors from the browser layer carry only a fixed reason code. */
export class BrowserError extends Error {
  constructor(readonly reason: string) {
    super(`Browser error: ${reason}`);
    this.name = "BrowserError";
  }
}

/** Host of the current page, or null while navigating/unparseable. Only https without port or userinfo counts. */
export function currentHost(session: Pick<BrowserSession, "url">): string | null {
  try {
    const url = new URL(session.url());
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/** Serialize a value for safe inclusion in an evaluate expression. Only for non-secret data (selectors, paths). */
export function js(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}
