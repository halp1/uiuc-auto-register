// A fake BrowserSession that simulates the Illinois SSO page sequence without a DOM.
// It understands the tagged probes from src/auth/page.ts.

import type { BrowserSession } from "../../src/auth/browser";
import { parseProbe, type PageSnapshot } from "../../src/auth/page";
import type { Clock } from "../../src/core/clock";

export type FieldName = "upn" | "loginfmt" | "passwd" | "otc";

export interface FakeAction {
  label: string;
  kind: "submit" | "button" | "back";
  onClick: (b: FakeBrowser) => void;
}

export interface FakePage {
  url: string;
  title?: string;
  fields?: Partial<Record<FieldName, { readOnly?: boolean; value?: string }>>;
  actions?: FakeAction[];
  syncToken?: boolean;
  flags?: Partial<PageSnapshot["flags"]>;
}

/** Clock whose sleep advances time immediately (and yields), so polling loops run instantly. */
export class AutoClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 2, 15, 0, 5)) {}
  now() {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    this.t += Math.max(0, ms);
    await Promise.resolve();
  }
  setTimeout(fn: () => void, ms: number) {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        this.t += ms;
        fn();
      }
    });
    return { cancel: () => (cancelled = true) };
  }
}

export class FakeBrowser implements BrowserSession {
  readonly backend: "chrome" | "webkit";
  page: FakePage;
  values: Partial<Record<FieldName, string>> = {};
  focused: FieldName | null = null;
  marks = new Map<string, { kind: "field"; field: FieldName } | { kind: "action"; action: FakeAction }>();
  typed: { host: string; field: FieldName | null; text: string }[] = [];
  clicks: string[] = [];
  evaluated: string[] = [];
  navigations: string[] = [];
  closed = false;
  cdp?: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onCdpEvent?: (name: string, fn: (params: any) => void) => () => void;
  /** Called before each probe, to mutate the page mid-flow (e.g. host switch). */
  beforeProbe: ((b: FakeBrowser, name: string) => void) | null = null;

  constructor(
    private readonly startPage: (b: FakeBrowser, url: string) => FakePage,
    backend: "chrome" | "webkit" = "chrome",
  ) {
    this.backend = backend;
    this.page = { url: "about:blank" };
  }

  show(page: FakePage) {
    this.page = page;
    this.values = {};
    for (const [name, field] of Object.entries(page.fields ?? {})) if (field?.value) this.values[name as FieldName] = field.value;
    this.focused = null;
    this.marks.clear();
  }

  host(): string {
    try {
      return new URL(this.page.url).hostname;
    } catch {
      return "";
    }
  }

  async navigate(url: string) {
    this.navigations.push(url);
    this.show(this.startPage(this, url));
  }

  url() {
    return this.page.url;
  }

  async evaluate<T>(expr: string): Promise<T> {
    if (this.closed) throw new Error("closed");
    this.evaluated.push(expr);
    const probe = parseProbe(expr);
    if (!probe) return this.evaluateOther(expr) as T;
    this.beforeProbe?.(this, probe.name);
    const page = this.page;
    const fields = page.fields ?? {};
    switch (probe.name) {
      case "snapshot": {
        const actions = page.actions ?? [];
        let secure = false;
        try {
          const u = new URL(page.url);
          secure = u.protocol === "https:" && !u.port;
        } catch {}
        const snap: PageSnapshot = {
          host: this.host(),
          secure,
          title: page.title ?? "",
          ready: true,
          fields: {
            upn: Boolean(fields.upn),
            loginfmt: Boolean(fields.loginfmt),
            loginfmtFilled: Boolean(this.values.loginfmt),
            passwd: Boolean(fields.passwd),
            otc: Boolean(fields.otc),
          },
          actions: actions.map(a => a.label),
          syncToken: Boolean(page.syncToken),
          flags: {
            passwordError: false,
            emptyPassword: false,
            otcError: false,
            kmsi: false,
            verifyIdentity: false,
            signInReady: Boolean(fields.passwd) && actions.some(a => a.kind === "submit" && /^sign in$/i.test(a.label)),
            ...page.flags,
          },
        };
        return snap as T;
      }
      case "markField": {
        const [selectors, nonce] = probe.args as [string[], string];
        const joined = selectors.join(" ");
        const field: FieldName | null = /upn/.test(joined) ? "upn" : /loginfmt/.test(joined) ? "loginfmt" : /passwd/.test(joined) ? "passwd" : /otc|one-time/.test(joined) ? "otc" : null;
        if (!field || !fields[field] || fields[field]!.readOnly) return null as T;
        const mark = `[data-uar-mark="${nonce}"]`;
        this.marks.set(mark, { kind: "field", field });
        return mark as T;
      }
      case "markAction": {
        const [selectors, source, flags, nonce] = probe.args as [string[], string, string, string];
        const pattern = new RegExp(source, flags);
        const onlyBack = selectors.length === 1 && selectors[0] === "#idBtn_Back";
        const onlySubmit = !selectors.includes("a") && !onlyBack;
        const action = (page.actions ?? []).find(a => {
          if (!pattern.test(a.label)) return false;
          if (onlyBack) return a.kind === "back";
          if (onlySubmit) return a.kind === "submit";
          return true;
        });
        if (!action) return null as T;
        const mark = `[data-uar-mark="${nonce}"]`;
        this.marks.set(mark, { kind: "action", action });
        return mark as T;
      }
      case "focusCheck": {
        const [mark, hosts] = probe.args as [string, string[]];
        const entry = this.marks.get(mark);
        return (entry?.kind === "field" && this.focused === entry.field && hosts.includes(this.host())) as T;
      }
      case "clearField": {
        const entry = this.marks.get(probe.args[0] as string);
        if (entry?.kind !== "field") return false as T;
        this.values[entry.field] = "";
        return true as T;
      }
      case "fieldFilled": {
        const entry = this.marks.get(probe.args[0] as string);
        return (entry?.kind === "field" && Boolean(this.values[entry.field])) as T;
      }
    }
    return undefined as T;
  }

  /** Non-probe evaluations (in-page fetch etc.). Override per test. */
  evaluateOther: (expr: string) => unknown = () => undefined;

  async click(selector: string) {
    this.clicks.push(selector);
    const entry = this.marks.get(selector);
    if (!entry) throw new Error("not actionable");
    if (entry.kind === "field") this.focused = entry.field;
    else entry.action.onClick(this);
  }

  async type(text: string) {
    this.typed.push({ host: this.host(), field: this.focused, text });
    if (this.focused) this.values[this.focused] = (this.values[this.focused] ?? "") + text;
  }

  async press() {}

  async waitFor(predicateExpr: string) {
    return Boolean(this.page.syncToken) || predicateExpr.length === 0;
  }

  async close() {
    this.closed = true;
  }
}

// ---------- the Illinois SSO sequence ----------

export const BANNER_URL = "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/term/termSelection?mode=registration&mepCode=1UIUC";

export interface FlowOptions {
  password: string;
  expectedCode: () => string;
  kmsi?: boolean;
  netidPrefilled?: boolean;
  /** Replace a page by name. */
  override?: Partial<Record<PageName, (b: FakeBrowser) => FakePage>>;
  /** Pages visited, in order. */
  visited?: PageName[];
}

export type PageName = "idp" | "netid" | "password" | "push" | "methods" | "otc" | "kmsi" | "banner";

export function illinoisFlow(opts: FlowOptions) {
  const visited = opts.visited ?? [];
  const go = (b: FakeBrowser, name: PageName) => {
    visited.push(name);
    b.show((opts.override?.[name] ?? pages[name])(b));
  };
  const pages: Record<PageName, (b: FakeBrowser) => FakePage> = {
    idp: () => ({
      url: "https://idpproxy.uillinois.edu/simplesaml/module.php/uidisco/disco.php?entityID=x",
      title: "Sign in",
      fields: { upn: {} },
      actions: [{ label: "Continue to sign in", kind: "submit", onClick: b => go(b, "netid") }],
    }),
    netid: () => ({
      url: "https://login.microsoftonline.com/common/oauth2/authorize",
      fields: { loginfmt: opts.netidPrefilled ? { readOnly: true, value: "x@illinois.edu" } : {} },
      actions: [{ label: "Next", kind: "submit", onClick: b => go(b, "password") }],
    }),
    password: () => ({
      url: "https://login.microsoftonline.com/common/login",
      fields: { passwd: {} },
      actions: [
        {
          label: "Sign in",
          kind: "submit",
          onClick: b => {
            if (b.values.passwd === opts.password) go(b, "push");
            else b.page = { ...b.page, flags: { passwordError: true } };
          },
        },
      ],
    }),
    push: () => ({
      url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
      flags: { verifyIdentity: false },
      actions: [{ label: "I can't use my Microsoft Authenticator app right now", kind: "button", onClick: b => go(b, "methods") }],
    }),
    methods: () => ({
      url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
      flags: { verifyIdentity: true },
      actions: [
        { label: "Approve a request on my Microsoft Authenticator app", kind: "button", onClick: () => {} },
        { label: "Use a verification code", kind: "button", onClick: b => go(b, "otc") },
      ],
    }),
    otc: () => ({
      url: "https://login.microsoftonline.com/common/SAS/ProcessAuth",
      fields: { otc: {} },
      actions: [
        {
          label: "Verify",
          kind: "submit",
          onClick: b => {
            if (b.values.otc === opts.expectedCode()) go(b, opts.kmsi === false ? "banner" : "kmsi");
            else b.page = { ...b.page, flags: { otcError: true } };
          },
        },
      ],
    }),
    kmsi: () => ({
      url: "https://login.microsoftonline.com/kmsi",
      flags: { kmsi: true },
      actions: [
        { label: "Yes", kind: "submit", onClick: () => {} },
        { label: "No", kind: "back", onClick: b => go(b, "banner") },
      ],
    }),
    banner: () => ({ url: "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb/term/termSelection?mode=registration", syncToken: true }),
  };
  return {
    visited,
    start: (b: FakeBrowser) => {
      visited.push("idp");
      return (opts.override?.idp ?? pages.idp)(b);
    },
    pages,
  };
}
