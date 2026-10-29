// HTTP side of app access (src/auth/access.ts): cookies, rate limits, passkeys, and the gate in front of /api.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { AccessControl, deviceName, PASSWORD_MAX, PASSWORD_MIN, publicPasskey, type SessionRow } from "../auth/access";
import type { Events } from "../core/events";
import type { AuthMode, AuthStatus } from "../core/types";

export type AuthRequest = Request & { params: Record<string, string> };
export type AuthServer = { requestIP(req: Request): { address: string } | null } | undefined;
type Handler = (req: AuthRequest, server?: AuthServer) => Response | Promise<Response>;

export class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Routes anyone may call, so a signed-out browser can sign in. */
export const PUBLIC_API = new Set([
  "/api/auth/status",
  "/api/auth/login",
  "/api/auth/recover",
  "/api/auth/passkeys/login/options",
  "/api/auth/passkeys/login/verify",
]);

const CHALLENGE_TTL_MS = 5 * 60_000;
const RP_NAME = "YUAR";

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** https as the browser sees it: the URL itself, or the proxy in front (Coolify, Cloudflare). */
export function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function requestHostname(req: Request): string {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  return host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
}

/** Passkeys need a domain name (never an IP) on https, or localhost. */
export function passkeyRpId(req: Request): string | null {
  const hostname = requestHostname(req);
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return null;
  const local = hostname === "localhost" || hostname.endsWith(".localhost");
  return local || isHttps(req) ? hostname : null;
}

/** For rate limits and the devices list. Behind a proxy every request shares its address, which is still safe. */
export function clientIp(req: Request, server?: AuthServer): string | null {
  const forwarded = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || server?.requestIP(req)?.address || null;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

async function body<T = any>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > 64 * 1024) throw new AuthHttpError(413, "Request is too large.");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AuthHttpError(400, "Request body is not valid JSON.");
  }
}

export interface AuthGate {
  /** null when the request may go on, else the 401 response. */
  check(req: Request): Response | null;
  /** Re-checks a long-lived request (the event stream). */
  stillAllowed(req: Request): boolean;
  onChange(fn: () => void): () => void;
}

export function authRoutes(access: AccessControl, events: Events) {
  const challenges = new Map<string, { kind: "register" | "login"; expires: number; sessionId: string | null }>();
  const takeChallenge = (challenge: string, kind: "register" | "login", sessionId: string | null) => {
    const now = Date.now();
    for (const [key, value] of challenges) if (value.expires < now) challenges.delete(key);
    const found = challenges.get(challenge);
    if (!found || found.kind !== kind || found.sessionId !== sessionId) return false;
    challenges.delete(challenge);
    return true;
  };
  const putChallenge = (challenge: string, kind: "register" | "login", sessionId: string | null) => {
    if (challenges.size > 200) challenges.delete(challenges.keys().next().value!);
    challenges.set(challenge, { kind, expires: Date.now() + CHALLENGE_TTL_MS, sessionId });
  };

  const token = (req: Request) => readCookie(req, access.cookieName());
  const current = (req: Request): SessionRow | null => access.session(token(req));
  const status = (req: Request, tok: string | null = token(req)): AuthStatus => {
    const rpId = passkeyRpId(req);
    return access.status(tok, rpId, rpId !== null);
  };

  /** maxAgeSec null: a browser-session cookie (gone when the browser closes). 0 clears it. */
  const cookie = (req: Request, value: string, maxAgeSec: number | null) =>
    [
      `${access.cookieName()}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      ...(maxAgeSec === null ? [] : [`Max-Age=${maxAgeSec}`]),
      ...(isHttps(req) ? ["Secure"] : []),
    ].join("; ");

  /** Sign this browser in. The body is the new status, or { ...extra, status } when extra is given. */
  const signIn = (req: Request, server: AuthServer, remember: boolean, extra?: Record<string, unknown>) => {
    const { token: tok, session } = access.createSession({
      remember,
      device: deviceName(req.headers.get("user-agent")),
      ip: clientIp(req, server),
    });
    const next = status(req, tok);
    const maxAge = remember ? Math.floor((session.expiresAt - Date.now()) / 1000) : null;
    return json(extra ? { ...extra, status: next } : next, 200, { "set-cookie": cookie(req, tok, maxAge) });
  };

  /** Throws 429 while this address is locked out. */
  const limited = (req: Request, server: AuthServer) => {
    const key = clientIp(req, server) ?? "unknown";
    const wait = access.limiter.retryAfter(key);
    if (wait > 0) throw new AuthHttpError(429, `Too many tries. Try again in ${wait} seconds.`, { retryAfter: wait });
    return key;
  };
  const failed = (key: string, what: string) => {
    access.limiter.fail(key);
    if (access.limiter.retryAfter(key) > 0)
      events.emit({ kind: "control", severity: "warning", title: "Sign-in paused after repeated failures", detail: what });
  };

  /** Checks the current password for sensitive changes, under the same rate limit as sign-in. */
  const confirmPassword = async (req: Request, server: AuthServer, password: unknown) => {
    const key = limited(req, server);
    if (typeof password !== "string" || !(await access.verifyPassword(password))) {
      failed(key, "Wrong current password");
      throw new AuthHttpError(403, "That password isn't right.");
    }
    access.limiter.success(key);
  };

  const validNewPassword = (value: unknown): string => {
    if (typeof value !== "string" || value.length < PASSWORD_MIN) throw new AuthHttpError(400, `Use at least ${PASSWORD_MIN} characters.`);
    if (value.length > PASSWORD_MAX) throw new AuthHttpError(400, `Use at most ${PASSWORD_MAX} characters.`);
    return value;
  };

  const needsPasswordMode = () => {
    if (access.mode() !== "password") throw new AuthHttpError(409, "Turn on the password first.");
  };

  const rpIdOrThrow = (req: Request) => {
    const rpId = passkeyRpId(req);
    if (!rpId) throw new AuthHttpError(409, "Passkeys need https or localhost.");
    return rpId;
  };
  /** The page's origin. checkRequestOrigin already made sure it matches the Host header. */
  const originOrThrow = (req: Request) => {
    const origin = req.headers.get("origin");
    if (!origin) throw new AuthHttpError(400, "Missing origin.");
    return origin;
  };

  const routes: Record<string, Record<string, Handler>> = {
    "/api/auth/status": { GET: req => json(status(req)) },

    "/api/auth/login": {
      POST: async (req, server) => {
        const key = limited(req, server);
        const { password, remember } = await body<{ password?: unknown; remember?: unknown }>(req);
        if (access.mode() !== "password") return json(status(req));
        if (typeof password !== "string" || !(await access.verifyPassword(password))) {
          failed(key, "Wrong password");
          const wait = access.limiter.retryAfter(key);
          if (wait > 0) throw new AuthHttpError(429, `Too many tries. Try again in ${wait} seconds.`, { retryAfter: wait });
          throw new AuthHttpError(401, "That password isn't right.");
        }
        access.limiter.success(key);
        return signIn(req, server, remember !== false);
      },
    },

    "/api/auth/logout": {
      POST: req => {
        const session = current(req);
        if (session) access.revokeSession(session.id);
        return json(status(req, null), 200, { "set-cookie": cookie(req, "", 0) });
      },
    },

    "/api/auth/configure": {
      POST: async (req, server) => {
        const raw = await body<{ mode?: unknown; password?: unknown; currentPassword?: unknown; remember?: unknown }>(req);
        const mode = raw.mode as AuthMode;
        if (mode !== "none" && mode !== "password") throw new AuthHttpError(400, "Choose password or none.");
        const before = access.mode();
        if (mode === "password") {
          if (before === "password") throw new AuthHttpError(409, "A password is already set. Change it in Settings instead.");
          const password = validNewPassword(raw.password);
          const codes = await access.setPassword(password, { newCodes: true });
          events.emit({ kind: "control", severity: "warning", title: "Password sign-in turned on" });
          return signIn(req, server, raw.remember !== false, { recoveryCodes: codes });
        }
        if (before === "password") await confirmPassword(req, server, raw.currentPassword);
        access.disable();
        if (before === "password") events.emit({ kind: "control", severity: "warning", title: "Password sign-in turned off" });
        return json({ status: status(req, null), recoveryCodes: null }, 200, { "set-cookie": cookie(req, "", 0) });
      },
    },

    "/api/auth/password": {
      POST: async (req, server) => {
        needsPasswordMode();
        const raw = await body<{ currentPassword?: unknown; newPassword?: unknown }>(req);
        const next = validNewPassword(raw.newPassword);
        await confirmPassword(req, server, raw.currentPassword);
        await access.setPassword(next, { newCodes: false });
        access.revokeOthers(current(req)?.id ?? null);
        events.emit({ kind: "control", severity: "warning", title: "Password changed", detail: "Other browsers were signed out." });
        return json(status(req));
      },
    },

    "/api/auth/recovery-codes": {
      POST: async (req, server) => {
        needsPasswordMode();
        const raw = await body<{ currentPassword?: unknown }>(req);
        await confirmPassword(req, server, raw.currentPassword);
        const codes = access.replaceRecoveryCodes();
        events.emit({ kind: "control", severity: "info", title: "New recovery codes made" });
        return json({ recoveryCodes: codes });
      },
    },

    "/api/auth/recover": {
      POST: async (req, server) => {
        const key = limited(req, server);
        const raw = await body<{ code?: unknown; newPassword?: unknown; remember?: unknown }>(req);
        if (access.mode() !== "password") throw new AuthHttpError(409, "There is no password to reset.");
        const next = validNewPassword(raw.newPassword);
        if (typeof raw.code !== "string" || !access.useRecoveryCode(raw.code)) {
          failed(key, "Wrong recovery code");
          throw new AuthHttpError(401, "That code isn't right or was already used.");
        }
        access.limiter.success(key);
        await access.setPassword(next, { newCodes: false });
        access.revokeOthers(null);
        events.emit({
          kind: "control",
          severity: "warning",
          title: "Password reset with a recovery code",
          detail: `${access.recoveryCodesLeft()} codes left. Other browsers were signed out.`,
        });
        return signIn(req, server, raw.remember !== false);
      },
    },

    "/api/auth/sessions": {
      GET: req => {
        needsPasswordMode();
        return json(access.listSessions(current(req)?.id ?? null));
      },
    },
    "/api/auth/sessions/:id": {
      DELETE: req => {
        needsPasswordMode();
        if (!access.revokeSession(req.params.id ?? "")) throw new AuthHttpError(404, "That device is already signed out.");
        return json({ ok: true });
      },
    },
    "/api/auth/sessions/revoke-others": {
      POST: req => {
        needsPasswordMode();
        access.revokeOthers(current(req)?.id ?? null);
        events.emit({ kind: "control", severity: "info", title: "Signed out every other browser" });
        return json({ ok: true });
      },
    },

    // ---- passkeys ----
    "/api/auth/passkeys": {
      GET: () => {
        needsPasswordMode();
        return json(access.passkeys().map(publicPasskey));
      },
    },
    "/api/auth/passkeys/register/options": {
      POST: async req => {
        needsPasswordMode();
        const rpId = rpIdOrThrow(req);
        const session = current(req);
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: rpId,
          userName: "you",
          userDisplayName: "YUAR",
          userID: access.userHandle() as Uint8Array<ArrayBuffer>,
          attestationType: "none",
          excludeCredentials: access.passkeys(rpId).map(p => ({ id: p.id, transports: p.transports as any })),
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
        });
        putChallenge(options.challenge, "register", session?.id ?? null);
        return json(options);
      },
    },
    "/api/auth/passkeys/register/verify": {
      POST: async req => {
        needsPasswordMode();
        const rpId = rpIdOrThrow(req);
        const raw = await body<{ response?: any; name?: unknown }>(req);
        const sessionId = current(req)?.id ?? null;
        let verified;
        try {
          verified = await verifyRegistrationResponse({
            response: raw.response,
            expectedChallenge: c => takeChallenge(c, "register", sessionId),
            expectedOrigin: originOrThrow(req),
            expectedRPID: rpId,
            requireUserVerification: true,
          });
        } catch {
          throw new AuthHttpError(400, "The passkey couldn't be added. Try again.");
        }
        if (!verified.verified || !verified.registrationInfo) throw new AuthHttpError(400, "The passkey couldn't be added. Try again.");
        const { credential } = verified.registrationInfo;
        if (access.passkey(credential.id)) throw new AuthHttpError(409, "That passkey is already added.");
        const name =
          typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : deviceName(req.headers.get("user-agent"));
        const saved = access.addPasskey({
          id: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
          name,
          rpId,
        });
        events.emit({ kind: "control", severity: "info", title: "Passkey added", detail: saved.name });
        return json(publicPasskey(saved));
      },
    },
    "/api/auth/passkeys/:id": {
      PATCH: async req => {
        needsPasswordMode();
        const { name } = await body<{ name?: unknown }>(req);
        if (typeof name !== "string" || !name.trim()) throw new AuthHttpError(400, "Give the passkey a name.");
        const saved = access.renamePasskey(req.params.id ?? "", name.trim());
        if (!saved) throw new AuthHttpError(404, "That passkey is gone.");
        return json(publicPasskey(saved));
      },
      DELETE: req => {
        needsPasswordMode();
        if (!access.removePasskey(req.params.id ?? "")) throw new AuthHttpError(404, "That passkey is gone.");
        events.emit({ kind: "control", severity: "info", title: "Passkey removed" });
        return json({ ok: true });
      },
    },
    "/api/auth/passkeys/login/options": {
      POST: async (req, server) => {
        limited(req, server);
        if (access.mode() !== "password") throw new AuthHttpError(409, "There is nothing to sign in to.");
        const rpId = rpIdOrThrow(req);
        if (access.passkeys(rpId).length === 0) throw new AuthHttpError(409, "No passkeys are set up for this address.");
        // Empty allowCredentials: the browser offers the passkeys it has for this site, so nothing is revealed here.
        const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: "required" });
        putChallenge(options.challenge, "login", null);
        return json(options);
      },
    },
    "/api/auth/passkeys/login/verify": {
      POST: async (req, server) => {
        const key = limited(req, server);
        if (access.mode() !== "password") throw new AuthHttpError(409, "There is nothing to sign in to.");
        const rpId = rpIdOrThrow(req);
        const raw = await body<{ response?: any; remember?: unknown }>(req);
        const stored = typeof raw.response?.id === "string" ? access.passkey(raw.response.id) : null;
        const fail = () => {
          failed(key, "Passkey sign-in failed");
          return new AuthHttpError(401, "That passkey didn't work. Try again or use your password.");
        };
        if (!stored || stored.rpId !== rpId) throw fail();
        let verified;
        try {
          verified = await verifyAuthenticationResponse({
            response: raw.response,
            expectedChallenge: c => takeChallenge(c, "login", null),
            expectedOrigin: originOrThrow(req),
            expectedRPID: rpId,
            credential: { id: stored.id, publicKey: stored.publicKey as Uint8Array<ArrayBuffer>, counter: stored.counter, transports: stored.transports as any },
            requireUserVerification: true,
          });
        } catch {
          throw fail();
        }
        if (!verified.verified) throw fail();
        access.limiter.success(key);
        access.passkeyUsed(stored.id, verified.authenticationInfo.newCounter);
        return signIn(req, server, raw.remember !== false);
      },
    },
  };

  const gate: AuthGate = {
    check(req) {
      const path = new URL(req.url).pathname;
      if (!path.startsWith("/api/") || PUBLIC_API.has(path)) return null;
      if (access.allowed(token(req))) return null;
      return json({ error: "Sign in to continue.", auth: "required" }, 401);
    },
    stillAllowed: req => access.allowed(token(req)),
    onChange: fn => access.onChange(fn),
  };

  return { routes, gate };
}
