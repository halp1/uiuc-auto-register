// Who may open this app. Separate from the Banner login in src/auth/login.ts.
//
// Mode "password": a password (argon2id via Bun.password) or a passkey signs a browser in. The browser gets an
// HttpOnly cookie holding a random token. Only the token's SHA-256 is stored. Mode "none": no sign-in at all.
// Mode null: not chosen yet (setup's first step), treated as open.
//
// Recovery without email: one-time recovery codes, or `bun run reset-auth` on the server.
// Everything lives in its own tables (migration 3), never in settings, so none of it can reach the client.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "../core/db";
import type { AuthMode, AuthSessionInfo, AuthStatus, PasskeyInfo } from "../core/types";

export const SESSION_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_SHORT_MS = 12 * 60 * 60 * 1000;
const SEEN_WRITE_MS = 60_000;
const MAX_SESSIONS = 50;
export const RECOVERY_CODE_COUNT = 8;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 256;

type Row = Record<string, any>;

export interface SessionRow {
  tokenHash: string;
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  remember: boolean;
  device: string;
  ip: string | null;
}

export interface StoredPasskey {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  name: string;
  rpId: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** 10 characters from an alphabet without look-alikes, shown as "xxxxx-xxxxx". About 50 bits each. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function makeRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Codes are typed by hand, so case, spaces and dashes don't matter. */
export function normalizeRecoveryCode(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]/g, "");
}

/** "Chrome on macOS" from a user agent. Only for the signed-in devices list. */
export function deviceName(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua) || /CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux|X11/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

// ---------- rate limiting ----------

const FAILS_PER_ROUND = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 60_000;
const GLOBAL_MAX_FAILS = 30;

/** Per-address lockouts that grow each round, plus a cap across all addresses (spoofed or proxied ones). */
export class Limiter {
  private byKey = new Map<string, { fails: number; rounds: number; lockedUntil: number }>();
  private global: number[] = [];
  private globalLockedUntil = 0;

  constructor(private now: () => number = Date.now) {}

  /** Seconds until another try is allowed, 0 when allowed now. */
  retryAfter(key: string): number {
    const now = this.now();
    const until = Math.max(this.byKey.get(key)?.lockedUntil ?? 0, this.globalLockedUntil);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  fail(key: string) {
    const now = this.now();
    const entry = this.byKey.get(key) ?? { fails: 0, rounds: 0, lockedUntil: 0 };
    entry.fails++;
    if (entry.fails >= FAILS_PER_ROUND) {
      entry.rounds++;
      entry.fails = 0;
      entry.lockedUntil = now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (entry.rounds - 1));
    }
    this.byKey.set(key, entry);
    this.global = this.global.filter(t => t > now - GLOBAL_WINDOW_MS);
    this.global.push(now);
    if (this.global.length >= GLOBAL_MAX_FAILS) {
      this.globalLockedUntil = now + GLOBAL_WINDOW_MS;
      this.global = [];
    }
    if (this.byKey.size > 1000) this.byKey.delete(this.byKey.keys().next().value!);
  }

  success(key: string) {
    this.byKey.delete(key);
  }
}

// ---------- the service ----------

export class AccessControl {
  readonly limiter: Limiter;
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.limiter = new Limiter(now);
  }

  private get db() {
    return this.store.db;
  }

  private kv(key: string): string | null {
    return ((this.db.query("SELECT value FROM auth_kv WHERE key = ?").get(key) as Row | null)?.value as string | undefined) ?? null;
  }

  private setKv(key: string, value: string | null) {
    if (value === null) this.db.query("DELETE FROM auth_kv WHERE key = ?").run(key);
    else this.db.query("INSERT INTO auth_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Random per-install id: cookie names differ between installs on the same host (cookies ignore ports). */
  private installId(): string {
    let id = this.kv("install_id");
    if (!id) {
      id = randomBytes(6).toString("hex");
      this.setKv("install_id", id);
    }
    return id;
  }

  cookieName(): string {
    return `uar_${this.installId()}`;
  }

  /** Stable random WebAuthn user handle for this install. */
  userHandle(): Uint8Array {
    let handle = this.kv("webauthn_user");
    if (!handle) {
      handle = randomBytes(16).toString("base64url");
      this.setKv("webauthn_user", handle);
    }
    return new Uint8Array(Buffer.from(handle, "base64url"));
  }

  /** Called on every change that could end a session: SSE streams re-check themselves. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {}
    }
  }

  // ---- mode and password ----

  mode(): AuthMode | null {
    const mode = this.kv("mode");
    // A password mode without a password hash (a damaged table) fails closed to "needs a reset", never open.
    return mode === "none" || mode === "password" ? mode : null;
  }

  hasPassword(): boolean {
    return this.kv("password_hash") !== null;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = this.kv("password_hash");
    if (!hash || typeof password !== "string" || password.length === 0 || password.length > PASSWORD_MAX) {
      // Same work as a real check so timing doesn't reveal whether a password is set.
      await Bun.password.verify("x", "$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$7rBzu3TqWfRcCFx1XBDUQaKmEbhJbTqKe3Hw1dvM1ZQ").catch(() => false);
      return false;
    }
    return Bun.password.verify(password, hash);
  }

  /** Switch to password mode (or change the password). Returns fresh recovery codes when asked. */
  async setPassword(password: string, opts: { newCodes: boolean }): Promise<string[] | null> {
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.store.tx(() => {
      this.setKv("password_hash", hash);
      this.setKv("mode", "password");
    });
    const codes = opts.newCodes ? this.replaceRecoveryCodes() : null;
    this.changed();
    return codes;
  }

  /** Turn sign-in off. Passkeys, recovery codes and sessions go with the password. */
  disable() {
    this.store.tx(() => {
      this.setKv("mode", "none");
      this.setKv("password_hash", null);
      this.db.exec("DELETE FROM auth_sessions; DELETE FROM passkeys; DELETE FROM recovery_codes;");
    });
    this.changed();
  }

  /** Used by `bun run reset-auth`: same as disable, from outside the app. */
  static reset(store: Store) {
    new AccessControl(store).disable();
  }

  // ---- recovery codes ----

  replaceRecoveryCodes(): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, makeRecoveryCode);
    this.store.tx(() => {
      this.db.exec("DELETE FROM recovery_codes");
      const insert = this.db.query("INSERT INTO recovery_codes (hash, used_at) VALUES (?, NULL)");
      for (const code of codes) insert.run(sha256(normalizeRecoveryCode(code)));
    });
    return codes;
  }

  recoveryCodesLeft(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL").get() as Row).n as number;
  }

  /** Marks the code used. True only for an unused code. */
  useRecoveryCode(raw: string): boolean {
    if (typeof raw !== "string" || raw.length > 64) return false;
    const hash = sha256(normalizeRecoveryCode(raw));
    const rows = this.db.query("SELECT hash FROM recovery_codes WHERE used_at IS NULL").all() as Row[];
    const match = rows.find(row => {
      const a = Buffer.from(row.hash as string, "hex");
      const b = Buffer.from(hash, "hex");
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!match) return false;
    return this.db.query("UPDATE recovery_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(this.now(), match.hash).changes === 1;
  }

  // ---- sessions ----

  createSession(opts: { remember: boolean; device: string; ip: string | null }): { token: string; session: SessionRow } {
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const session: SessionRow = {
      tokenHash: sha256(token),
      id: randomBytes(9).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + (opts.remember ? SESSION_REMEMBER_MS : SESSION_SHORT_MS),
      remember: opts.remember,
      device: opts.device.slice(0, 80),
      ip: opts.ip?.slice(0, 64) ?? null,
    };
    this.store.tx(() => {
      this.db.query("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
      // Keep the newest sessions only.
      this.db
        .query(`DELETE FROM auth_sessions WHERE id NOT IN (SELECT id FROM auth_sessions ORDER BY last_seen_at DESC LIMIT ${MAX_SESSIONS - 1})`)
        .run();
      this.db
        .query("INSERT INTO auth_sessions (token_hash, id, created_at, last_seen_at, expires_at, remember, device, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(session.tokenHash, session.id, now, now, session.expiresAt, session.remember ? 1 : 0, session.device, session.ip);
    });
    return { token, session };
  }

  /** The live session for a cookie token. Slides the expiry forward (at most once a minute). */
  session(token: string | null): SessionRow | null {
    if (!token || token.length > 128) return null;
    const row = this.db.query("SELECT * FROM auth_sessions WHERE token_hash = ?").get(sha256(token)) as Row | null;
    if (!row) return null;
    const now = this.now();
    if (row.expires_at <= now) {
      this.db.query("DELETE FROM auth_sessions WHERE token_hash = ?").run(row.token_hash);
      return null;
    }
    const session = sessionFromRow(row);
    if (now - session.lastSeenAt >= SEEN_WRITE_MS) {
      session.lastSeenAt = now;
      session.expiresAt = now + (session.remember ? SESSION_REMEMBER_MS : SESSION_SHORT_MS);
      this.db.query("UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(now, session.expiresAt, session.tokenHash);
    }
    return session;
  }

  /** True when this token may use the app right now. */
  allowed(token: string | null): boolean {
    return this.mode() !== "password" || this.session(token) !== null;
  }

  listSessions(currentId: string | null): AuthSessionInfo[] {
    const rows = this.db.query("SELECT * FROM auth_sessions WHERE expires_at > ? ORDER BY last_seen_at DESC").all(this.now()) as Row[];
    return rows.map(row => {
      const s = sessionFromRow(row);
      return { id: s.id, current: s.id === currentId, device: s.device, ip: s.ip, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, remember: s.remember };
    });
  }

  revokeSession(id: string): boolean {
    const changed = this.db.query("DELETE FROM auth_sessions WHERE id = ?").run(id).changes > 0;
    if (changed) this.changed();
    return changed;
  }

  revokeOthers(keepId: string | null) {
    if (keepId) this.db.query("DELETE FROM auth_sessions WHERE id != ?").run(keepId);
    else this.db.exec("DELETE FROM auth_sessions");
    this.changed();
  }

  // ---- passkeys ----

  passkeys(rpId?: string): StoredPasskey[] {
    const rows = (rpId
      ? this.db.query("SELECT * FROM passkeys WHERE rp_id = ? ORDER BY created_at").all(rpId)
      : this.db.query("SELECT * FROM passkeys ORDER BY created_at").all()) as Row[];
    return rows.map(passkeyFromRow);
  }

  passkey(id: string): StoredPasskey | null {
    const row = this.db.query("SELECT * FROM passkeys WHERE id = ?").get(id) as Row | null;
    return row ? passkeyFromRow(row) : null;
  }

  addPasskey(p: Omit<StoredPasskey, "createdAt" | "lastUsedAt">): StoredPasskey {
    const now = this.now();
    this.db
      .query("INSERT INTO passkeys (id, public_key, counter, transports, name, rp_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(p.id, p.publicKey, p.counter, JSON.stringify(p.transports), p.name.slice(0, 60), p.rpId, now);
    return { ...p, createdAt: now, lastUsedAt: null };
  }

  passkeyUsed(id: string, counter: number) {
    this.db.query("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, this.now(), id);
  }

  renamePasskey(id: string, name: string): StoredPasskey | null {
    this.db.query("UPDATE passkeys SET name = ? WHERE id = ?").run(name.slice(0, 60), id);
    return this.passkey(id);
  }

  removePasskey(id: string): boolean {
    return this.db.query("DELETE FROM passkeys WHERE id = ?").run(id).changes > 0;
  }

  status(token: string | null, rpId: string | null, passkeysSupported: boolean): AuthStatus {
    const mode = this.mode();
    const authenticated = mode !== "password" || this.session(token) !== null;
    return {
      mode,
      authenticated,
      passkeyLogin: mode === "password" && passkeysSupported && rpId !== null && this.passkeys(rpId).length > 0,
      passkeysSupported,
      recoveryCodesLeft: mode === "password" && authenticated ? this.recoveryCodesLeft() : null,
    };
  }
}

export function publicPasskey(p: StoredPasskey): PasskeyInfo {
  return { id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, host: p.rpId };
}

function sessionFromRow(row: Row): SessionRow {
  return {
    tokenHash: row.token_hash,
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    remember: Boolean(row.remember),
    device: row.device,
    ip: row.ip,
  };
}

function passkeyFromRow(row: Row): StoredPasskey {
  return {
    id: row.id,
    publicKey: new Uint8Array(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports),
    name: row.name,
    rpId: row.rp_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}
