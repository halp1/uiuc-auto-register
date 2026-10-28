// Builds the real Banner integration for rehearsal and live modes (see src/real-banner.ts).

import type { Registrar } from "../core/contracts";
import type { RealBanner, RealBannerDeps } from "../real-banner";
import { BannerSessionManager } from "./session";
import { LiveRegistrar, liveGate, makePostSubmitCheck } from "./registrar/live";
import { RehearsalRegistrar } from "./registrar/rehearsal";

export const KEEP_WARM_CHECK_MS = 30_000;

export function createRealBanner(deps: RealBannerDeps): RealBanner {
  const { config, store, clock, settings } = deps;
  if (config.mode === "simulated") throw new Error("Real Banner is not available in simulated mode");
  const session = new BannerSessionManager({ config, events: deps.events, store, clock, settings });
  const rehearsal = new RehearsalRegistrar({ api: session.readApi(), clock, store });
  let timer: { cancel(): void } | null = null;
  let running = false;
  let checking = false;

  // One LiveRegistrar per liveTerm so its in-flight guard spans calls. It still re-checks the gate on every register().
  let live: { term: string; registrar: LiveRegistrar } | null = null;
  const registrar = (): Registrar => {
    if (config.mode !== "live") return rehearsal;
    const current = settings();
    // Live switch off or no live term: dry-run instead of throwing.
    if (liveGate(config, current, current.liveTerm) || !current.liveTerm) return rehearsal;
    if (live?.term === current.liveTerm) return live.registrar;
    try {
      live = { term: current.liveTerm, registrar: new LiveRegistrar({ config, settings, store, clock, api: session.writeApi() }, current.liveTerm) };
      return live.registrar;
    } catch {
      return rehearsal;
    }
  };

  const wantWarm = (): string | null => {
    const s = settings();
    if (s.globalPaused || !s.activeTerm) return null;
    if (s.sessionPausedUntil && s.sessionPausedUntil > clock.now()) return null;
    return store.armedCrns(s.activeTerm).length > 0 ? s.activeTerm : null;
  };

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const term = wantWarm();
      const state = session.state();
      if (term && state !== "logging_in" && state !== "paused") await session.ensureWarm(term).catch(() => {});
      else if (!term && state === "warm") await session.goCold("idle");
    } finally {
      checking = false;
    }
  };

  const loop = () => {
    if (!running) return;
    timer = clock.setTimeout(() => {
      void check().finally(loop);
    }, KEEP_WARM_CHECK_MS);
  };

  return {
    session,
    registrar,
    postSubmitCheck: config.mode === "live" ? makePostSubmitCheck({ api: session.readApi(), store }) : undefined,
    sessionStatus: () => session.status(),
    onSettingsChanged: () => {
      if (running) void check();
    },
    start: () => {
      if (running) return;
      running = true;
      void check().finally(loop);
    },
    stop: async () => {
      running = false;
      timer?.cancel();
      timer = null;
      await session.dispose();
    },
  };
}
