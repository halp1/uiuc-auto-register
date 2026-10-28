import { describe, expect, test } from "bun:test";
import { SimRegistrar } from "../../src/banner/registrar/sim";
import { SIM_TERM, SimBanner, SimSeatSource } from "../../src/banner/sim/state";

const T = SIM_TERM;

describe("SimBanner", () => {
  test("seeded closed sections and a schedule", async () => {
    const sim = new SimBanner();
    expect(sim.schedule(T)).toEqual(["41234", "52345"]);
    const seats = await new SimSeatSource(sim).fetchSeats(T, ["59777", "31225"]);
    expect(seats.every(seat => seat.available === 0)).toBe(true);
    sim.setSeats(T, "59777", 2);
    const [seat] = await new SimSeatSource(sim).fetchSeats(T, ["59777"]);
    expect(seat).toMatchObject({ available: 2, max: 400, enrolled: 398 });
  });

  test("reset restores the seed", () => {
    const sim = new SimBanner();
    sim.setSeats(T, "59777", 5);
    sim.setSchedule(T, []);
    sim.scriptError(null, "x");
    sim.reset();
    expect(sim.peek(T, "59777")?.available).toBe(0);
    expect(sim.schedule(T)).toEqual(["41234", "52345"]);
    expect(sim.state().scripted).toEqual([]);
  });
});

describe("SimRegistrar", () => {
  const request = (addCrns: string[], dropCrn: string | null = null) => ({ term: T, bundleId: 1, addCrns, dropCrn });

  test("closed section fails atomically", async () => {
    const sim = new SimBanner();
    sim.setSeats(T, "59777", 1);
    const result = await new SimRegistrar(sim).register(request(["59777", "31225"]));
    expect(result.outcome).toBe("failed");
    expect(result.classification).toBe("transient");
    expect(result.rows.find(row => row.crn === "31225")?.message).toBe("Closed Section");
    expect(sim.peek(T, "59777")?.available).toBe(1);
    expect(sim.schedule(T)).not.toContain("59777");
  });

  test("success takes seats and adds to the schedule, with optional drop", async () => {
    const sim = new SimBanner();
    sim.setSeats(T, "59777", 1);
    sim.setSeats(T, "31225", 3);
    const result = await new SimRegistrar(sim).register(request(["59777", "31225"], "41234"));
    expect(result.outcome).toBe("success");
    expect(sim.peek(T, "59777")?.available).toBe(0);
    expect(sim.peek(T, "31225")?.available).toBe(2);
    expect(sim.schedule(T).sort()).toEqual(["31225", "52345", "59777"]);
    expect(sim.peek(T, "41234")?.available).toBe(4);
  });

  test("scripted errors apply once", async () => {
    const sim = new SimBanner();
    sim.setSeats(T, "59777", 5);
    sim.scriptError("59777", "Prerequisite and Test Score error");
    const registrar = new SimRegistrar(sim);
    const first = await registrar.register(request(["59777"]));
    expect(first.outcome).toBe("failed");
    expect(first.classification).toBe("permanent");
    expect(first.rows[0]?.message).toBe("Prerequisite and Test Score error");
    expect((await registrar.register(request(["59777"]))).outcome).toBe("success");
  });

  test("time conflict is permanent, not-open is transient", async () => {
    const sim = new SimBanner();
    sim.setSeats(T, "59777", 5);
    sim.scriptError(null, "Time conflict with CRN 41234");
    sim.scriptError(null, "Registration is not open at this time");
    const registrar = new SimRegistrar(sim);
    expect((await registrar.register(request(["59777"]))).classification).toBe("permanent");
    expect((await registrar.register(request(["59777"]))).classification).toBe("transient");
  });
});
