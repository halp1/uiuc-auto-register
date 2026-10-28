// The only bridge to the real Banner account (rehearsal and live modes).
// Simulated mode never imports this file's dependencies.

import type { Bus } from "./core/bus";
import type { Clock } from "./core/clock";
import type { Config } from "./core/config";
import type { Registrar, SessionManager } from "./core/contracts";
import type { Store } from "./core/db";
import type { Events } from "./core/events";
import type { RegisterRequest, RegisterResult, Settings, SystemStatus } from "./core/types";

export interface RealBanner {
  session: SessionManager;
  /** Returns the registrar for the current mode. Live is re-validated by LiveRegistrar on every call. */
  registrar(): Registrar;
  postSubmitCheck?: (request: RegisterRequest, result: RegisterResult) => Promise<{ ok: boolean; detail: string }>;
  sessionStatus(): SystemStatus["session"];
  onSettingsChanged(): void;
  start(): void;
  stop(): Promise<void>;
}

export interface RealBannerDeps {
  config: Config;
  store: Store;
  events: Events;
  bus: Bus;
  clock: Clock;
  settings: () => Settings;
}

export async function loadRealBanner(deps: RealBannerDeps): Promise<RealBanner> {
  if (deps.config.mode === "simulated") throw new Error("Real Banner is not available in simulated mode");
  const mod = await import("./banner/real");
  return mod.createRealBanner(deps);
}
