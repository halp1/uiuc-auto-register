import { join } from "node:path";
import type { AppServices } from "./api/services";
import { AnonymousSeatSource } from "./banner/enrollment";
import { LinkedSections } from "./banner/linked";
import { SimRegistrar } from "./banner/registrar/sim";
import { SimBanner, SimSeatSource } from "./banner/sim/state";
import { Explorer } from "./catalog/explorer";
import { courseDetail, search } from "./catalog/search";
import { getStoredCourse } from "./catalog/store";
import { CatalogSync } from "./catalog/sync";
import { Bus } from "./core/bus";
import { systemClock, type Clock } from "./core/clock";
import type { Config } from "./core/config";
import type { Registrar, RehearsalReport, SeatSource, SessionManager } from "./core/contracts";
import { Store } from "./core/db";
import { Events } from "./core/events";
import { isTermCode } from "./core/terms";
import type { Settings, SystemStatus } from "./core/types";
import { Orchestrator } from "./engine/orchestrator";
import { PlanService } from "./engine/plans";
import { Poller } from "./engine/poller";
import { TicketScheduler } from "./engine/ticket";
import { TicketDetector } from "./engine/ticket-detect";
import { NotificationRouter } from "./notify/router";
import { loadRealBanner, type RealBanner } from "./real-banner";

export interface App {
  services: AppServices;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createApp(config: Config, options: { clock?: Clock; store?: Store } = {}): Promise<App> {
  const clock = options.clock ?? systemClock;
  const store = options.store ?? Store.open(config.dataDir);
  const bus = new Bus();
  const events = new Events(store, bus);
  const startedAt = Date.now();
  const settings = () => store.getSettings();

  // Live authorization never survives a mode downgrade: if .env no longer says live, Live is off.
  if (config.mode !== "live" && store.getSettings().liveEnabled) store.updateSettings({ liveEnabled: false, liveTerm: null });

  // ---- Banner access per mode ----
  const sim = config.mode === "simulated" ? new SimBanner() : null;
  let real: RealBanner | null = null;
  if (config.mode !== "simulated") real = await loadRealBanner({ config, store, events, bus, clock, settings });
  const session: SessionManager | null = real?.session ?? null;

  const primary: SeatSource = sim ? new SimSeatSource(sim) : new AnonymousSeatSource();
  const registrar = (): Registrar => {
    if (sim) return new SimRegistrar(sim);
    // Fail closed: only real-banner decides, and it re-checks mode + Live switch on every call.
    return real!.registrar();
  };

  // ---- notifications ----
  const notifier = new NotificationRouter({ store, settings, updateSettings: patch => store.updateSettings(patch), events });
  events.onEvent(event => notifier.handle(event));

  // ---- engine ----
  let ticket!: TicketScheduler;
  const orchestrator = new Orchestrator({
    store,
    events,
    bus,
    clock,
    registrar,
    settings,
    updateSettings: patch => applySettings(patch),
    notifier: {
      approvalCreated: approval => notifier.approvalCreated(approval),
      approvalResolved: (approval, text) => notifier.approvalResolved(approval, text),
      approvalReminder: approval => notifier.approvalReminder(approval),
    },
    postSubmitCheck: real?.postSubmitCheck,
    firing: () => ticket?.firing() ?? false,
  });
  notifier.setControl(orchestrator);

  const poller = new Poller({
    store,
    events,
    bus,
    clock,
    primary,
    fallback: () => (session ? session.authenticatedSeatSource() : null),
    onSeatsUpdated: () => orchestrator.evaluate("seats"),
    settings,
  });

  ticket = new TicketScheduler({
    clock,
    settings,
    ensureWarm: term => (session ? session.ensureWarm(term) : Promise.resolve()),
    orchestrator,
    poller,
    events,
  });

  const ticketDetector = new TicketDetector({
    clock,
    settings,
    applySettings: patch => applySettings(patch),
    events,
    readTicket: session ? term => session.readTicket(term) : null,
    ticketPhase: () => ticket.status().phase,
  });

  // ---- catalog ----
  const catalog = new CatalogSync({ store, events });
  const explorer = new Explorer();
  const linked = new LinkedSections(store);
  const plans = new PlanService({
    store,
    events,
    activeTerm: () => settings().activeTerm,
    loadDetail: (term, subject, number, opts) =>
      courseDetail(store, term, subject, number, { explorer, linked, seatSource: opts.seats ? primary : undefined }),
  });

  // ---- status ----
  const status = (): SystemStatus => {
    const s = settings();
    return {
      mode: config.mode,
      backend: config.browserBackend,
      globalPaused: s.globalPaused,
      liveEnabled: s.liveEnabled,
      liveTerm: s.liveTerm,
      guardTripped: orchestrator.guardState(),
      poller: poller.status(),
      session: real
        ? real.sessionStatus()
        : { state: "cold", since: null, lastKeepaliveAt: null, pausedUntil: s.sessionPausedUntil, lastError: null, stage: null },
      ticket: ticket.status(),
      catalog: catalog.status(s.activeTerm),
      startedAt,
    };
  };

  let lastStatus = "";
  const publishStatus = () => {
    const next = status();
    const key = JSON.stringify({ ...next, poller: { ...next.poller, nextCycleAt: null } });
    if (key === lastStatus) return;
    lastStatus = key;
    bus.publish({ type: "status", status: next });
  };
  // Event-driven status, plus a slow tick for timers (countdowns, poller cycle times).
  bus.subscribe(message => {
    if (message.type === "event" || message.type === "seats") queueMicrotask(publishStatus);
  });

  const publishWanted = () => {
    const term = settings().activeTerm;
    bus.publish({ type: "wanted", wanted: term ? store.listWanted(term) : [] });
  };
  sim?.onChange(() => {
    const term = settings().activeTerm;
    if (term) bus.publish({ type: "seats", seats: store.listSeats(term) });
  });

  function applySettings(patch: Partial<Settings>) {
    const before = settings();
    const after = store.updateSettings(patch);
    const pub = store.publicSettings(after);
    bus.publish({ type: "settings", settings: pub });
    if (patch.discordToken !== undefined || patch.discordUserId !== undefined) void notifier.reload();
    if (patch.ticketAt !== undefined || patch.activeTerm !== undefined) ticket.reschedule();
    ticketDetector.settingsChanged(before, after);
    if (patch.activeTerm !== undefined && patch.activeTerm !== before.activeTerm) {
      publishWanted();
      if (after.activeTerm) bus.publish({ type: "seats", seats: store.listSeats(after.activeTerm) });
      catalog.startDaily(() => settings().activeTerm);
    }
    if (patch.pollIntervalSec !== undefined || patch.activeTerm !== undefined || patch.globalPaused !== undefined || patch.overnightSlow !== undefined) poller.kick();
    if (patch.globalPaused === false || patch.approvalMode !== undefined) orchestrator.evaluate("settings");
    if (patch.globalPaused !== undefined || patch.liveEnabled !== undefined) real?.onSettingsChanged();
    publishStatus();
    return pub;
  }

  const services: AppServices = {
    config,
    store,
    bus,
    events,
    poller,
    orchestrator,
    ticket,
    session,
    notifier,
    control: orchestrator,
    catalog,
    sim,
    search: (term, q) => search(store, term, q),
    courseDetail: (term, subject, number) => courseDetail(store, term, subject, number, { explorer, linked, seatSource: primary }),
    courseTitle: async (term, subject, number) => {
      const stored = getStoredCourse(store, term, subject, number);
      if (stored) return stored.title;
      return (await courseDetail(store, term, subject, number, { explorer }))?.title ?? null;
    },
    planGenerate: planId => plans.generate(planId),
    planTarget: (planId, picks) => plans.target(planId, picks),
    terms: () => catalog.terms(),
    status,
    settings,
    applySettings,
    rehearse: async (term: string): Promise<RehearsalReport> => {
      if (!session) throw new Error("No Banner session in simulated mode");
      const crns = store.armedCrns(term);
      const report = await session.rehearse(term, crns);
      events.emit({
        kind: "rehearsal_result",
        severity: report.ok ? "success" : "warning",
        title: report.ok ? "Rehearsal passed" : "Rehearsal found problems",
        detail: report.steps.filter(step => !step.ok).map(step => `${step.name}: ${step.detail ?? "failed"}`).join("\n") || null,
        payload: report,
      });
      return report;
    },
    detectTicket: term => ticketDetector.detect(term, { manual: true }),
    discordStatus: () => notifier.discordStatus(),
  };

  let tick: ReturnType<typeof setInterval> | undefined;
  let prune: ReturnType<typeof setInterval> | undefined;

  return {
    services,
    async start() {
      // Default the term to the newest one Banner lists when nothing is chosen yet.
      if (!settings().activeTerm) {
        const terms = await catalog.terms().catch(() => []);
        const first = terms.find(term => isTermCode(term.code));
        if (first) store.updateSettings({ activeTerm: first.code });
      }
      store.pruneEvents();
      await notifier.start();
      poller.start();
      ticket.start();
      ticketDetector.start();
      catalog.startDaily(() => settings().activeTerm);
      real?.start();

      const s = settings();
      const armed = s.activeTerm ? store.listWanted(s.activeTerm).filter(course => course.armed).length : 0;
      events.emit({
        kind: "restarted",
        severity: "info",
        title: "Started",
        detail: `${armed} armed ${armed === 1 ? "course" : "courses"}, Live ${s.liveEnabled ? "on" : "off"}${s.globalPaused ? ", paused" : ""}`,
        payload: { mode: config.mode },
      });
      orchestrator.evaluate("startup");
      tick = setInterval(publishStatus, 2000);
      prune = setInterval(() => store.pruneEvents(), 6 * 60 * 60 * 1000);
    },
    async stop() {
      if (tick) clearInterval(tick);
      if (prune) clearInterval(prune);
      catalog.stopDaily();
      ticket.stop();
      ticketDetector.stop();
      await poller.stop();
      await orchestrator.stop();
      await real?.stop();
      await notifier.dispose();
      store.close();
    },
  };
}

export const swPath = join(import.meta.dir, "..", "web", "sw.ts");
