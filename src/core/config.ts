import { existsSync } from "node:fs";
import type { Mode } from "./types";

/** Process settings. The app reads no environment variables: these come from CLI flags and the stored mode. */
export interface Config {
  mode: Mode;
  dataDir: string;
  port: number;
  host: string;
  chromePath: string | null;
  /** Started with `bun --hot`. Live registration stays off so a reload can never leave two submitters. */
  hotReload: boolean;
}

export interface CliOptions {
  dataDir: string;
  port: number;
  host: string;
}

const MODES: readonly Mode[] = ["simulated", "rehearsal", "live"];

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** `--port 3000 --host 0.0.0.0 --data /data`, each also accepted as `--flag=value`. */
export function parseArgs(argv: string[]): CliOptions {
  const out: CliOptions = { dataDir: "./data", port: 3000, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const value = () => (eq >= 0 ? arg.slice(eq + 1) : argv[++i]);
    if (name === "--port") {
      const port = Number(value());
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be a valid port number");
      out.port = port;
    } else if (name === "--host") {
      const host = value();
      if (!host) throw new Error("--host needs a value");
      out.host = host;
    } else if (name === "--data") {
      const dir = value();
      if (!dir) throw new Error("--data needs a value");
      out.dataDir = dir;
    }
  }
  return out;
}

const CHROME_PATHS = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];

/** The system Chromium in the Docker image. Elsewhere Bun finds Chrome on its own. */
export function findChrome(): string | null {
  return CHROME_PATHS.find(path => existsSync(path)) ?? null;
}

export function makeConfig(mode: Mode, opts: Partial<CliOptions> & { hotReload?: boolean; chromePath?: string | null } = {}): Config {
  return {
    mode,
    dataDir: opts.dataDir ?? "./data",
    port: opts.port ?? 3000,
    host: opts.host ?? "127.0.0.1",
    chromePath: opts.chromePath === undefined ? findChrome() : opts.chromePath,
    hotReload: opts.hotReload ?? false,
  };
}
