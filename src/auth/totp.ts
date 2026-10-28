// RFC 6238 TOTP (SHA-1, 30 second step, 6 digits) for a standard base32 seed.
// Ported from uiuc-totp/src/login.js.

import { createHmac } from "node:crypto";
import type { Clock } from "../core/clock";

export const TOTP_STEP_MS = 30_000;
/** Codes are only typed in the first part of a window so they cannot expire mid-submit. */
export const TOTP_MAX_SECONDS_INTO_WINDOW = 22;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class InvalidTotpSecret extends Error {
  constructor() {
    super("Invalid base32 TOTP seed");
    this.name = "InvalidTotpSecret";
  }
}

function decodeBase32(secret: string): Buffer {
  const base32 = secret.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]+$/.test(base32) || base32.length < 16) throw new InvalidTotpSecret();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of base32) {
    value = ((value << 5) | ALPHABET.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

/** The TOTP code for the window containing `timestamp` (epoch ms). */
export function totp(secret: string, timestamp = Date.now()): string {
  return totpForWindow(secret, totpWindow(timestamp));
}

export function totpForWindow(secret: string, window: number): string {
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(window));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

export function totpWindow(timestamp: number): number {
  return Math.floor(timestamp / TOTP_STEP_MS);
}

export function secondsIntoWindow(timestamp: number): number {
  return (timestamp % TOTP_STEP_MS) / 1000;
}

/** True when the seed decodes. Never reveals anything about the seed. */
export function isValidTotpSecret(secret: string | null | undefined): boolean {
  if (!secret) return false;
  try {
    decodeBase32(secret);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hands out TOTP windows so that no window is ever used twice, and no code is typed
 * late in its window (more than 22 s in means wait for the next edge).
 * Share one tracker across logins in a process.
 */
export class TotpWindowTracker {
  private last: number | null = null;

  constructor(
    private readonly maxSecondsIntoWindow = TOTP_MAX_SECONDS_INTO_WINDOW,
    private readonly edgeMarginMs = 250,
  ) {}

  lastWindow(): number | null {
    return this.last;
  }

  /** Milliseconds until `acquire` could return, 0 when a window is usable now. */
  waitMs(now: number): number {
    const window = totpWindow(now);
    const fresh = this.last === null || window > this.last;
    if (fresh && secondsIntoWindow(now) <= this.maxSecondsIntoWindow) return 0;
    return (window + 1) * TOTP_STEP_MS - now + this.edgeMarginMs;
  }

  /** Wait (on the given clock) for a fresh, early window, mark it used, and return its index. */
  async acquire(clock: Clock, signal?: AbortSignal, onWait?: (ms: number) => void): Promise<number> {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const now = clock.now();
      const wait = this.waitMs(now);
      if (wait === 0) {
        const window = totpWindow(now);
        this.last = window;
        return window;
      }
      onWait?.(wait);
      await clock.sleep(wait, signal);
    }
  }
}
