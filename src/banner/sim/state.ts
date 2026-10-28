// In-memory fake Banner for simulated mode and tests. Never talks to the network.

import type { SeatSource, SimBannerApi } from "../../core/contracts";
import type { SeatInfo } from "../../core/types";

export const SIM_TERM = "120271";

interface SimSeat {
  term: string;
  crn: string;
  available: number;
  max: number;
  enrolled: number;
  changedAt: number;
}

export interface SimSeed {
  seats: { term: string; crn: string; available: number; max: number }[];
  schedule: Record<string, string[]>;
}

/**
 * Real Spring 2027 CRNs (Course Explorer, captured 2026-10-28), all closed so the student can open them
 * from the sim panel. CS 225: AL1 31208, AL2 59777, lab-discussions AYA..AYH. CS 374: AL1 65088 with
 * discussions AYA..AYC. MATH 241: AL1 46060 with discussions ADA..ADC.
 */
export function defaultSimSeed(): SimSeed {
  const closed = (crn: string, max: number) => ({ term: SIM_TERM, crn, available: 0, max });
  return {
    seats: [
      closed("31208", 400),
      closed("59777", 400),
      closed("31234", 24),
      closed("31222", 24),
      closed("31225", 24),
      closed("31227", 24),
      closed("31229", 24),
      closed("31231", 24),
      closed("59778", 24),
      closed("65088", 250),
      closed("65089", 30),
      closed("65090", 30),
      closed("65091", 30),
      closed("46060", 200),
      closed("46053", 28),
      closed("46054", 28),
      closed("46056", 28),
      // The existing schedule's sections.
      { term: SIM_TERM, crn: "41234", available: 3, max: 40 },
      { term: SIM_TERM, crn: "52345", available: 5, max: 35 },
    ],
    schedule: { [SIM_TERM]: ["41234", "52345"] },
  };
}

/** Linked-section data matching the seed, for simulated course detail views. */
export const SIM_LINKED: Record<string, string[][]> = {
  "31208": [["31234"], ["31222"], ["31225"], ["31227"], ["31229"], ["31231"], ["59778"]],
  "59777": [["31225"], ["31234"], ["31231"], ["59778"], ["31229"], ["31227"], ["31222"]],
  "65088": [["65089"], ["65090"], ["65091"]],
  "46060": [["46053"], ["46054"], ["46056"]],
};

export class SimBanner implements SimBannerApi {
  private seats = new Map<string, SimSeat>();
  private schedules = new Map<string, Set<string>>();
  private scripted: { crn: string | null; message: string }[] = [];
  private listeners = new Set<() => void>();

  constructor(
    private seed: SimSeed = defaultSimSeed(),
    private now: () => number = Date.now,
  ) {
    this.reset();
  }

  /** Called after any change (the API publishes sim state to the UI). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("sim listener failed", error);
      }
    }
  }

  private key(term: string, crn: string): string {
    return `${term}:${crn}`;
  }

  /** Seat record, created closed (max 30) for CRNs the seed does not know. */
  ensure(term: string, crn: string): SimSeat {
    const key = this.key(term, crn);
    let seat = this.seats.get(key);
    if (!seat) {
      seat = { term, crn, available: 0, max: 30, enrolled: 30, changedAt: this.now() };
      this.seats.set(key, seat);
    }
    return seat;
  }

  peek(term: string, crn: string): SimSeat | null {
    return this.seats.get(this.key(term, crn)) ?? null;
  }

  setSeats(term: string, crn: string, available: number, max?: number): void {
    const seat = this.ensure(term, crn);
    const nextMax = Math.max(0, Math.floor(max ?? Math.max(seat.max, available)));
    const nextAvailable = Math.max(0, Math.min(Math.floor(available), nextMax));
    if (nextAvailable !== seat.available) seat.changedAt = this.now();
    seat.max = nextMax;
    seat.available = nextAvailable;
    seat.enrolled = nextMax - nextAvailable;
    this.changed();
  }

  /** Take one seat (registration). Returns false when closed. */
  take(term: string, crn: string): boolean {
    const seat = this.ensure(term, crn);
    if (seat.available <= 0) return false;
    seat.available -= 1;
    seat.enrolled += 1;
    seat.changedAt = this.now();
    return true;
  }

  /** Give one seat back (drop). */
  release(term: string, crn: string): void {
    const seat = this.ensure(term, crn);
    if (seat.enrolled <= 0) return;
    seat.enrolled -= 1;
    seat.available = Math.min(seat.max, seat.available + 1);
    seat.changedAt = this.now();
  }

  scriptError(crn: string | null, message: string): void {
    this.scripted.push({ crn, message });
    this.changed();
  }

  /** Remove and return the first scripted error that applies to any of these CRNs. */
  takeScripted(crns: string[]): { crn: string | null; message: string } | null {
    const index = this.scripted.findIndex(entry => entry.crn === null || crns.includes(entry.crn));
    if (index < 0) return null;
    const [entry] = this.scripted.splice(index, 1);
    this.changed();
    return entry!;
  }

  setSchedule(term: string, crns: string[]): void {
    this.schedules.set(term, new Set(crns));
    for (const crn of crns) this.ensure(term, crn);
    this.changed();
  }

  schedule(term: string): string[] {
    return [...(this.schedules.get(term) ?? [])];
  }

  addToSchedule(term: string, crns: string[]): void {
    const set = this.schedules.get(term) ?? new Set<string>();
    crns.forEach(crn => set.add(crn));
    this.schedules.set(term, set);
  }

  removeFromSchedule(term: string, crn: string): boolean {
    return this.schedules.get(term)?.delete(crn) ?? false;
  }

  /** Notify listeners after a batch of take/release/schedule changes. */
  commit(): void {
    this.changed();
  }

  state(): { seats: SeatInfo[]; schedule: Record<string, string[]>; scripted: { crn: string | null; message: string }[] } {
    const now = this.now();
    return {
      seats: [...this.seats.values()]
        .map(seat => ({ ...seat, checkedAt: now }))
        .sort((a, b) => a.term.localeCompare(b.term) || a.crn.localeCompare(b.crn)),
      schedule: Object.fromEntries([...this.schedules.entries()].map(([term, set]) => [term, [...set]])),
      scripted: this.scripted.map(entry => ({ ...entry })),
    };
  }

  reset(): void {
    this.seats.clear();
    this.schedules.clear();
    this.scripted = [];
    for (const seat of this.seed.seats) {
      this.seats.set(this.key(seat.term, seat.crn), {
        ...seat,
        enrolled: seat.max - seat.available,
        changedAt: this.now(),
      });
    }
    for (const [term, crns] of Object.entries(this.seed.schedule)) this.schedules.set(term, new Set(crns));
    this.changed();
  }
}

/** Seat source backed by SimBanner. Unknown CRNs appear closed so they show up in the sim panel. */
export class SimSeatSource implements SeatSource {
  readonly kind = "simulated" as const;

  constructor(
    private sim: SimBanner,
    private options: { latencyMs?: number; now?: () => number } = {},
  ) {}

  async fetchSeats(term: string, crns: string[], signal?: AbortSignal): Promise<Omit<SeatInfo, "changedAt">[]> {
    if (this.options.latencyMs) await Bun.sleep(this.options.latencyMs);
    if (signal?.aborted) throw signal.reason;
    const now = (this.options.now ?? Date.now)();
    return [...new Set(crns)].map(crn => {
      const seat = this.sim.ensure(term, crn);
      return { term, crn, available: seat.available, max: seat.max, enrolled: seat.enrolled, checkedAt: now };
    });
  }
}
