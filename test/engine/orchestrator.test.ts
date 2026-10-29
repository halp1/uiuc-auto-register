import { describe, expect, test } from "bun:test";
import { SimRegistrar } from "../../src/banner/registrar/sim";
import { SIM_TERM, SimBanner, SimSeatSource } from "../../src/banner/sim/state";
import { Bus } from "../../src/core/bus";
import { FakeClock } from "../../src/core/clock";
import type { Registrar } from "../../src/core/contracts";
import { Store, defaultSettings } from "../../src/core/db";
import { Events } from "../../src/core/events";
import type { Approval, RegisterRequest, RegisterResult, Settings, StreamMessage } from "../../src/core/types";
import { Orchestrator, REMIND_AFTER_MS, type OrchestratorDeps } from "../../src/engine/orchestrator";
import { Poller } from "../../src/engine/poller";

const T = SIM_TERM;
const LEC = "59777";
const LAB1 = "31225";
const LAB2 = "31234";

function setup(opts: { settings?: Partial<Settings>; registrar?: Registrar; deps?: Partial<OrchestratorDeps> } = {}) {
  const clock = new FakeClock();
  const store = new Store(":memory:");
  const bus = new Bus();
  const events = new Events(store, bus);
  store.updateSettings({ activeTerm: T, jitterPct: 0, ...opts.settings });
  const sim = new SimBanner(undefined, () => clock.now());
  const registrar = opts.registrar ?? new SimRegistrar(sim, { now: () => clock.now() });
  const hooks = { created: [] as Approval[], resolved: [] as [Approval, string][], reminders: [] as Approval[] };
  const messages: StreamMessage[] = [];
  bus.subscribe(message => messages.push(message));
  const registerCalls: RegisterRequest[] = [];
  const orchestrator = new Orchestrator({
    store,
    events,
    bus,
    clock,
    registrar: () => ({
      kind: registrar.kind,
      register: request => {
        registerCalls.push(request);
        return registrar.register(request);
      },
    }),
    settings: () => store.getSettings(),
    updateSettings: patch => store.updateSettings(patch),
    notifier: {
      approvalCreated: approval => hooks.created.push(approval),
      approvalResolved: (approval, text) => hooks.resolved.push([approval, text]),
      approvalReminder: approval => hooks.reminders.push(approval),
    },
    ...opts.deps,
  });
  const source = new SimSeatSource(sim, { now: () => clock.now() });

  /** Copy sim seats for every bundle CRN into the store and evaluate (what the poller does). */
  const tick = async (reason = "test") => {
    const crns = [...new Set(store.listWanted(T).flatMap(course => course.bundles.flatMap(bundle => bundle.crns)))];
    for (const seat of await source.fetchSeats(T, crns)) store.upsertSeat(seat);
    orchestrator.evaluate(reason);
    await orchestrator.idle();
  };

  const want = (subject: string, number: string, bundles: string[][], armed = true) => {
    const course = store.createWanted({ term: T, subject, number, title: `${subject} ${number}`, kind: "bundles" });
    store.setBundles(course.id, bundles.map(crns => ({ crns })));
    if (armed) store.updateWanted(course.id, { armed: true });
    return store.getWanted(course.id)!;
  };

  const kinds = () => store.listEvents(500).map(event => event.kind).reverse();
  const bundles = (courseId: number) => store.getWanted(courseId)!.bundles.map(bundle => bundle.state);

  return { clock, store, sim, orchestrator, hooks, messages, registerCalls, tick, want, kinds, bundles, events, bus, source };
}

describe("auto mode", () => {
  test("registers when the whole bundle opens, not before", async () => {
    const t = setup();
    const course = t.want("CS", "225", [[LEC, LAB1]]);
    await t.tick();
    expect(t.registerCalls.length).toBe(0);

    t.sim.setSeats(T, LEC, 3);
    await t.tick();
    expect(t.registerCalls.length).toBe(0); // lab still closed

    t.sim.setSeats(T, LAB1, 1);
    await t.tick();
    expect(t.registerCalls).toEqual([{ term: T, bundleId: course.bundles[0]!.id, addCrns: [LEC, LAB1], dropCrn: null }]);
    const after = t.store.getWanted(course.id)!;
    expect(after).toMatchObject({ state: "registered", armed: false });
    expect(after.bundles[0]!.state).toBe("registered");
    expect(t.sim.schedule(T).sort()).toEqual([LAB1, "41234", "52345", LEC].sort());
    const registered = t.store.listEvents().find(event => event.kind === "registered")!;
    expect(registered.severity).toBe("success");
    expect(t.messages.some(message => message.type === "wanted")).toBe(true);

    // Idempotent: no further attempts.
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
  });

  test("higher priority course goes first, one at a time", async () => {
    const t = setup();
    const math = t.want("MATH", "241", [["46060", "46053"]]);
    const cs = t.want("CS", "225", [[LEC, LAB1]]);
    t.store.reorderWanted([cs.id, math.id]);
    for (const crn of ["46060", "46053", LEC, LAB1]) t.sim.setSeats(T, crn, 2);
    t.orchestrator.evaluate("a");
    t.orchestrator.evaluate("b");
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns[0])).toEqual([LEC, "46060"]);
  });

  test("swap drop only when swaps are unlocked", async () => {
    const locked = setup();
    const c1 = locked.want("CS", "225", [[LEC]]);
    locked.store.updateWanted(c1.id, { swapDropCrn: "41234" });
    locked.sim.setSeats(T, LEC, 1);
    await locked.tick();
    expect(locked.registerCalls[0]!.dropCrn).toBeNull();

    const unlocked = setup({ settings: { swapsUnlocked: true } });
    const c2 = unlocked.want("CS", "225", [[LEC]]);
    unlocked.store.updateWanted(c2.id, { swapDropCrn: "41234" });
    unlocked.sim.setSeats(T, LEC, 1);
    await unlocked.tick();
    expect(unlocked.registerCalls[0]!.dropCrn).toBe("41234");
    expect(unlocked.sim.schedule(T)).not.toContain("41234");
  });

  test("permanent error blocks the bundle and the next bundle wins", async () => {
    const t = setup();
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    for (const crn of [LEC, LAB1, LAB2]) t.sim.setSeats(T, crn, 2);
    t.sim.scriptError(LAB1, "Time conflict with CRN 41234");
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB1], [LEC, LAB2]]);
    const after = t.store.getWanted(course.id)!;
    expect(after.bundles[0]).toMatchObject({ state: "blocked", blockedReason: "Time conflict with CRN 41234" });
    expect(after.bundles[1]!.state).toBe("registered");
    expect(after.state).toBe("registered");
    const failed = t.store.listEvents().find(event => event.kind === "registration_failed")!;
    expect(failed.severity).toBe("critical");
  });

  test("permanent errors on every bundle mark the course blocked", async () => {
    const t = setup();
    const course = t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.scriptError(null, "Prerequisite and Test Score error");
    await t.tick();
    expect(t.store.getWanted(course.id)!.state).toBe("blocked");
    expect(t.store.armedCrns(T)).toEqual([]);
  });

  test("unknown result after submit halts and trips the guard, next bundle untouched", async () => {
    const t = setup();
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    const other = t.want("MATH", "241", [["46060"]]);
    for (const crn of [LEC, LAB1, LAB2, "46060"]) t.sim.setSeats(T, crn, 2);
    t.sim.scriptError(null, "Something odd happened");
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB1]]);
    expect(t.bundles(course.id)).toEqual(["blocked", "open"]);
    expect(t.store.getWanted(other.id)!.state).toBe("watching");
    expect(t.store.getSettings().globalPaused).toBe(true);
    expect(t.orchestrator.guardState()?.detail).toBe(
      `Unclear result for CS 225 ${LEC} + ${LAB1}: Something odd happened. Check your schedule in Banner, then clear the guard.`,
    );
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
  });

  test("registrar throwing (e.g. timeout after submit) halts and trips", async () => {
    const throwing: Registrar = {
      kind: "simulated",
      register: async () => {
        throw new Error("Timed out waiting for Banner after submit");
      },
    };
    const t = setup({ registrar: throwing });
    t.want("CS", "225", [[LEC], [LAB1]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.setSeats(T, LAB1, 2);
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
    expect(t.orchestrator.guardState()?.detail).toContain("Timed out waiting for Banner after submit");
  });

  test("permanent with no rows ok blocks and moves to the next bundle", async () => {
    const registrar: Registrar = {
      kind: "simulated",
      register: async request =>
        request.addCrns.includes(LAB1)
          ? {
              outcome: "failed",
              rows: request.addCrns.map(crn => ({ crn, ok: false, message: crn === LAB1 ? "Time conflict with CRN 41234" : null })),
              classification: "permanent",
              message: "Time conflict with CRN 41234",
              ms: 1,
            }
          : { outcome: "success", rows: request.addCrns.map(crn => ({ crn, ok: true, message: null })), classification: null, message: null, ms: 1 },
    };
    const t = setup({ registrar });
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    for (const crn of [LEC, LAB1, LAB2]) t.sim.setSeats(T, crn, 2);
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB1], [LEC, LAB2]]);
    expect(t.bundles(course.id)).toEqual(["blocked", "registered"]);
    expect(t.orchestrator.guardState()).toBeNull();
  });

  test("permanent with one row ok is treated as unclear and trips", async () => {
    const registrar: Registrar = {
      kind: "simulated",
      register: async request => ({
        outcome: "failed",
        rows: [
          { crn: request.addCrns[0]!, ok: true, message: null },
          { crn: request.addCrns[1]!, ok: false, message: "Prerequisite and Test Score error" },
        ],
        classification: "permanent",
        message: "Prerequisite and Test Score error",
        ms: 1,
      }),
    };
    const t = setup({ registrar });
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    for (const crn of [LEC, LAB1, LAB2]) t.sim.setSeats(T, crn, 2);
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
    expect(t.bundles(course.id)[0]).toBe("blocked");
    expect(t.store.getSettings().globalPaused).toBe(true);
    expect(t.orchestrator.guardState()?.detail).toContain(`accepted: ${LEC}`);
  });

  test("transient failure keeps watching with a 30 s cooldown", async () => {
    const t = setup();
    const course = t.want("CS", "225", [[LEC, LAB1]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.setSeats(T, LAB1, 2);
    t.sim.scriptError(null, "Registration is not open at this time");
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
    expect(t.bundles(course.id)).toEqual(["watching"]);
    const attempt = t.store.listEvents().find(event => event.kind === "attempt")!;
    expect(attempt.severity).toBe("info");

    await t.tick();
    expect(t.registerCalls.length).toBe(1); // cooling down

    await t.clock.advance(30_001);
    await t.orchestrator.idle();
    expect(t.registerCalls.length).toBe(2);
    expect(t.store.getWanted(course.id)!.state).toBe("registered");
  });

  test("repeated transient failures escalate to a warning", async () => {
    const t = setup();
    t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.scriptError(null, "Closed Section");
    t.sim.scriptError(null, "Closed Section");
    await t.tick();
    await t.clock.advance(30_001);
    await t.orchestrator.idle();
    const failed = t.store.listEvents().filter(event => event.kind === "registration_failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.severity).toBe("warning");
  });

  test("no cooldown while the ticket is firing", async () => {
    let firing = true;
    const t = setup({ deps: { firing: () => firing } });
    t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.scriptError(null, "Registration is not open at this time");
    await t.tick();
    await t.tick();
    expect(t.registerCalls.length).toBe(2);
    firing = false;
  });

  test("paused or disarmed: nothing registers, open bundle announced once", async () => {
    const t = setup({ settings: { globalPaused: true } });
    t.want("CS", "225", [[LEC]]);
    t.want("CS", "374", [["65088"]], false);
    t.sim.setSeats(T, LEC, 2);
    t.sim.setSeats(T, "65088", 2);
    await t.tick();
    await t.tick();
    expect(t.registerCalls.length).toBe(0);
    expect(t.kinds().filter(kind => kind === "bundle_opened").length).toBe(1);
    t.orchestrator.resumeAll("test");
    await t.orchestrator.idle();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC]]);
  });

  test("holds attempts until the ticket time", async () => {
    const t = setup();
    t.store.updateSettings({ ticketAt: new Date(t.clock.now() + 60_000).toISOString() });
    t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 2);
    await t.tick();
    expect(t.registerCalls.length).toBe(0);
    await t.clock.advance(60_000);
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
  });
});

describe("guard", () => {
  test("aborted result trips the guard and pauses everything", async () => {
    const aborting: Registrar = {
      kind: "live",
      register: async () => ({ outcome: "aborted", rows: [], classification: null, message: "Interceptor refused a drop", ms: 1 }),
    };
    const t = setup({ registrar: aborting });
    const course = t.want("CS", "225", [[LEC]]);
    t.want("CS", "374", [["65088"]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.setSeats(T, "65088", 2);
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
    expect(t.store.getSettings().globalPaused).toBe(true);
    expect(t.orchestrator.guardState()?.detail).toBe("Interceptor refused a drop");
    const tripped = t.store.listEvents().find(event => event.kind === "guard_tripped")!;
    expect(tripped.severity).toBe("critical");
    expect(t.bundles(course.id)).toEqual(["watching"]);

    // Resume alone does not register while the guard is tripped.
    t.store.updateSettings({ globalPaused: false });
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
    t.orchestrator.clearGuard();
    await t.tick();
    expect(t.registerCalls.length).toBe(2);
  });

  test("post-submit check failure trips the guard", async () => {
    const checks: [RegisterRequest, RegisterResult][] = [];
    const t = setup({
      deps: {
        postSubmitCheck: async (request, result) => {
          checks.push([request, result]);
          return { ok: false, detail: "CRN 41234 disappeared from the schedule" };
        },
      },
    });
    const course = t.want("CS", "225", [[LEC]]);
    t.want("MATH", "241", [["46060"]]);
    t.sim.setSeats(T, LEC, 2);
    t.sim.setSeats(T, "46060", 2);
    await t.tick();
    expect(checks.length).toBe(1);
    expect(t.registerCalls.length).toBe(1);
    expect(t.orchestrator.guardState()?.detail).toContain("41234");
    expect(t.store.getSettings().globalPaused).toBe(true);
    expect(t.store.getWanted(course.id)!.state).toBe("registered");
  });

  test("post-submit check failure after a failed submit halts without trying the next bundle", async () => {
    const t = setup({ deps: { postSubmitCheck: async () => ({ ok: false, detail: "Schedule changed unexpectedly" }) } });
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    for (const crn of [LEC, LAB1, LAB2]) t.sim.setSeats(T, crn, 2);
    t.sim.scriptError(LAB1, "Time conflict with CRN 41234");
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB1]]);
    expect(t.bundles(course.id)).toEqual(["blocked", "open"]);
    expect(t.orchestrator.guardState()?.detail).toBe("Schedule changed unexpectedly");
  });
});

describe("approve mode", () => {
  test("creates one approval per course, approve() registers", async () => {
    const t = setup({ settings: { approvalMode: "approve" } });
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    for (const crn of [LEC, LAB1, LAB2]) t.sim.setSeats(T, crn, 2);
    await t.tick();
    await t.tick();
    expect(t.registerCalls.length).toBe(0);
    const pending = t.store.pendingApprovals();
    expect(pending.length).toBe(1);
    expect(pending[0]).toMatchObject({ crns: [LEC, LAB1], label: `CS 225 ${LEC} + ${LAB1}`, remindAt: t.clock.now() + REMIND_AFTER_MS, autoAt: null });
    expect(t.bundles(course.id)).toEqual(["pending_approval", "open"]);
    expect(t.hooks.created.length).toBe(1);
    const needed = t.store.listEvents().find(event => event.kind === "approval_needed")!;
    expect(needed.severity).toBe("warning");
    expect(t.kinds()).toContain("bundle_opened");
    expect(t.messages.some(message => message.type === "approvals" && message.approvals.length === 1)).toBe(true);

    const result = await t.orchestrator.approve(pending[0]!.id, "web");
    expect(result.ok).toBe(true);
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB1]]);
    expect(t.store.getApproval(pending[0]!.id)!.state).toBe("approved");
    expect(t.store.getWanted(course.id)!.state).toBe("registered");
    expect(t.hooks.resolved[0]![1]).toContain("Registered");
    expect((await t.orchestrator.approve(pending[0]!.id, "web")).ok).toBe(false);
  });

  test("uses section names from the catalog in labels", async () => {
    const t = setup({ settings: { approvalMode: "approve" } });
    t.store.db
      .query("INSERT INTO cat_sections (term, crn, subject, number, section, type, type_name) VALUES (?, ?, 'CS', '225', ?, 'LEC', 'Lecture')")
      .run(T, LEC, "AL2");
    t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 2);
    await t.tick();
    expect(t.store.pendingApprovals()[0]!.label).toBe("CS 225 AL2");
  });

  test("expires when a seat closes, then prompts again on reopen", async () => {
    const t = setup({ settings: { approvalMode: "approve" } });
    const course = t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    const approval = t.store.pendingApprovals()[0]!;
    t.sim.setSeats(T, LEC, 0);
    await t.tick();
    expect(t.store.getApproval(approval.id)!.state).toBe("expired");
    expect(t.bundles(course.id)).toEqual(["watching"]);
    expect(t.hooks.resolved).toEqual([[expect.objectContaining({ id: approval.id }), "Expired, seat closed"]]);
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    expect(t.store.pendingApprovals().length).toBe(1);
  });

  test("approve after the seat closed fails and expires", async () => {
    const t = setup({ settings: { approvalMode: "approve" } });
    t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    const approval = t.store.pendingApprovals()[0]!;
    t.store.upsertSeat({ term: T, crn: LEC, available: 0, max: 400, enrolled: 400, checkedAt: t.clock.now() });
    const result = await t.orchestrator.approve(approval.id, "discord");
    expect(result.ok).toBe(false);
    expect(t.store.getApproval(approval.id)!.state).toBe("expired");
    expect(t.registerCalls.length).toBe(0);
  });

  test("skip suppresses re-prompting until the bundle closes and reopens", async () => {
    const t = setup({ settings: { approvalMode: "approve" } });
    const course = t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    const approval = t.store.pendingApprovals()[0]!;
    expect((await t.orchestrator.skip(approval.id, "web")).ok).toBe(true);
    expect(t.store.getApproval(approval.id)!.state).toBe("skipped");
    expect(t.bundles(course.id)).toEqual(["watching"]);
    await t.tick();
    await t.tick();
    expect(t.store.pendingApprovals().length).toBe(0);
    t.sim.setSeats(T, LEC, 0);
    await t.tick();
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    expect(t.store.pendingApprovals().length).toBe(1);
  });

  test("reminder once at 5 min, auto-register at autoAt", async () => {
    const t = setup({ settings: { approvalMode: "approve", approvalAutoAfterMin: 10 } });
    const course = t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    const approval = t.store.pendingApprovals()[0]!;
    expect(approval.autoAt).toBe(t.clock.now() + 10 * 60_000);
    await t.clock.advance(REMIND_AFTER_MS);
    await t.orchestrator.idle();
    expect(t.hooks.reminders.length).toBe(1);
    await t.clock.advance(60_000);
    await t.orchestrator.idle();
    expect(t.hooks.reminders.length).toBe(1);
    expect(t.registerCalls.length).toBe(0);
    await t.clock.advance(4 * 60_000);
    await t.orchestrator.idle();
    expect(t.registerCalls.length).toBe(1);
    expect(t.store.getApproval(approval.id)!.state).toBe("auto");
    expect(t.store.getWanted(course.id)!.state).toBe("registered");
  });
});

describe("rehearsal dry runs", () => {
  test("dry_run logs once per opening and keeps watching", async () => {
    const dry: Registrar = {
      kind: "rehearsal",
      register: async () => ({ outcome: "dry_run", rows: [], classification: null, message: "Rehearsal: nothing submitted", ms: 3 }),
    };
    const t = setup({ registrar: dry });
    const course = t.want("CS", "225", [[LEC]]);
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
    expect(t.bundles(course.id)).toEqual(["open"]);
    const attempt = t.store.listEvents().find(event => event.kind === "attempt")!;
    expect(attempt.title).toBe(`Rehearsal: would register CS 225 ${LEC}`);
    t.sim.setSeats(T, LEC, 0);
    await t.tick();
    t.sim.setSeats(T, LEC, 1);
    await t.tick();
    expect(t.registerCalls.length).toBe(2);
  });
});

describe("with the poller", () => {
  test("poller seat updates drive registration", async () => {
    const t = setup();
    const course = t.want("CS", "225", [[LEC, LAB1]]);
    const poller = new Poller({
      store: t.store,
      events: t.events,
      bus: t.bus,
      clock: t.clock,
      primary: t.source,
      fallback: () => null,
      onSeatsUpdated: () => t.orchestrator.evaluate("seats"),
      settings: () => t.store.getSettings(),
      random: () => 0.5,
    });
    poller.start();
    await t.clock.advance(1_000);
    t.sim.setSeats(T, LEC, 1);
    t.sim.setSeats(T, LAB1, 1);
    await t.clock.advance(10_000);
    await t.orchestrator.idle();
    expect(t.store.getWanted(course.id)!.state).toBe("registered");
    await t.clock.advance(10_000);
    expect(poller.status()).toMatchObject({ state: "idle", watchedCrns: 0 });
    await poller.stop();
    await t.orchestrator.stop();
  });

  test("statusText summarizes", async () => {
    const t = setup();
    t.want("CS", "225", [[LEC]]);
    expect(t.orchestrator.statusText()).toContain("CS 225: watching, 0 of 1 bundles open");
  });
});

describe("plan conflict filter", () => {
  const insertSection = (store: Store, crn: string, subject: string, number: string, days: string, start: string, end: string, part = "1") =>
    store.db
      .query(
        `INSERT INTO cat_sections (term, crn, subject, number, section, type, type_name, part_of_term, meetings)
         VALUES (?, ?, ?, ?, ?, 'LEC', 'Lecture', ?, ?)`,
      )
      .run(T, crn, subject, number, crn, part, JSON.stringify([{ type: "LEC", typeName: "Lecture", days, start, end, building: null, room: null, instructors: [] }]));

  function planned() {
    const t = setup();
    insertSection(t.store, LEC, "CS", "225", "MWF", "11:00", "11:50");
    insertSection(t.store, LAB1, "CS", "225", "R", "11:00", "12:50");
    insertSection(t.store, LAB2, "CS", "225", "R", "09:00", "10:50");
    insertSection(t.store, "41234", "MATH", "241", "R", "11:30", "12:20");
    const plan = t.store.createPlan(T, "Plan 1");
    const course = t.want("CS", "225", [[LEC, LAB1], [LEC, LAB2]]);
    t.store.setWantedPlan(course.id, plan.id);
    for (const crn of [LEC, LAB1, LAB2]) t.sim.setSeats(T, crn, 2);
    return { ...t, course, plan };
  }

  test("plan course skips an open bundle that clashes with the latest schedule", async () => {
    const t = planned();
    t.store.addScheduleSnapshot(T, ["41234", "52345"], "rehearsal");
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB2]]);
    // Filter only: the skipped bundle keeps its normal state.
    expect(t.store.getWanted(t.course.id)!.bundles[0]!.blockedReason).toBeNull();
  });

  test("plan course skips a bundle that clashes with another registered course", async () => {
    const t = planned();
    const math = t.want("MATH", "241", [["41234"]], false);
    t.store.setBundleState(math.bundles[0]!.id, "registered");
    t.store.setCourseState(math.id, "registered");
    t.sim.setSeats(T, LAB2, 0);
    await t.tick();
    expect(t.registerCalls.length).toBe(0);
    expect(t.bundles(t.course.id)).toEqual(["open", "watching"]);
  });

  test("courses without a plan are not filtered", async () => {
    const t = planned();
    t.store.setWantedPlan(t.course.id, null);
    t.store.addScheduleSnapshot(T, ["41234"], "rehearsal");
    await t.tick();
    expect(t.registerCalls.map(call => call.addCrns)).toEqual([[LEC, LAB1]]);
  });

  test("different halves of the term do not clash", async () => {
    const t = setup();
    insertSection(t.store, LEC, "CS", "225", "R", "11:00", "11:50", "A");
    insertSection(t.store, "41234", "MATH", "241", "R", "11:00", "11:50", "B");
    const plan = t.store.createPlan(T, "Plan 1");
    const course = t.want("CS", "225", [[LEC]]);
    t.store.setWantedPlan(course.id, plan.id);
    t.store.addScheduleSnapshot(T, ["41234"], "rehearsal");
    t.sim.setSeats(T, LEC, 2);
    await t.tick();
    expect(t.registerCalls.length).toBe(1);
  });
});
