import type { Mode } from "./types";

export interface Config {
  mode: Mode;
  dataDir: string;
  port: number;
  host: string;
  browserBackend: "chrome" | "webkit";
  chromePath: string | null;
  hasCredentials: boolean;
  isTest: boolean;
}

const MODES: readonly Mode[] = ["simulated", "rehearsal", "live"];

export function parseMode(raw: string | undefined): Mode {
  if (raw === undefined || raw === "") return "simulated";
  // "test" is the name the UI uses. "rehearsal" stays accepted for existing .env files.
  if (raw === "test") return "rehearsal";
  if ((MODES as readonly string[]).includes(raw)) return raw as Mode;
  // Fail closed: an unrecognized value must never become "live".
  throw new Error("REGISTRATION_MODE must be one of simulated, test, live");
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const backend = env.BROWSER_BACKEND ?? "chrome";
  if (backend !== "chrome" && backend !== "webkit") throw new Error("BROWSER_BACKEND must be chrome or webkit");
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid port number");
  return {
    mode: parseMode(env.REGISTRATION_MODE),
    dataDir: env.DATA_DIR || "./data",
    port,
    host: env.HOST || "127.0.0.1",
    browserBackend: backend,
    chromePath: env.BUN_CHROME_PATH || null,
    hasCredentials: Boolean(env.UIUC_NETID && env.UIUC_PASSWORD && env.UIUC_TOTP_SECRET),
    isTest: env.NODE_ENV === "test",
  };
}
