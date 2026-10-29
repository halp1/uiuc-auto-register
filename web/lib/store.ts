import { useRef, useSyncExternalStore } from "react";
import type {
  AppEvent,
  Approval,
  Plan,
  PublicSettings,
  SeatInfo,
  Snapshot,
  StreamMessage,
  SystemStatus,
  Term,
  WantedCourse,
} from "../../src/core/types";
import { api, isMock } from "./api";
import { getAuth, onSignOut, setAuthStatus } from "./auth";
import { errorMessage } from "./utils";

export type Connection = "connecting" | "open" | "reconnecting";

export interface ClientState {
  status: SystemStatus | null;
  settings: PublicSettings | null;
  wanted: WantedCourse[];
  seats: Record<string, SeatInfo>; // key `${term}:${crn}`
  approvals: Approval[];
  events: AppEvent[];
  terms: Term[];
  connection: Connection;
  loadError: string | null;
  /** crn key -> epoch ms when the client saw the seat count change (drives the row flash) */
  seatFlash: Record<string, number>;
  /** term -> plans, loaded on demand by the planner and kept fresh by the stream */
  plans: Record<string, Plan[]>;
}

const EVENT_CAP = 200;

let state: ClientState = {
  status: null,
  settings: null,
  wanted: [],
  seats: {},
  approvals: [],
  events: [],
  terms: [],
  connection: "connecting",
  loadError: null,
  seatFlash: {},
  plans: {},
};

const listeners = new Set<() => void>();

function set(patch: Partial<ClientState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState(): ClientState {
  return state;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Selector hook. Results are cached per state object, so selectors may return fresh arrays safely. */
export function useStore<T>(selector: (s: ClientState) => T): T {
  const cache = useRef<{ state: ClientState; value: T } | null>(null);
  const get = () => {
    if (cache.current && cache.current.state === state) return cache.current.value;
    const value = selector(state);
    if (cache.current && shallowEqual(cache.current.value, value)) {
      cache.current = { state, value: cache.current.value };
      return cache.current.value;
    }
    cache.current = { state, value };
    return value;
  };
  return useSyncExternalStore(subscribe, get, get);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return false;
}

export const seatKey = (term: string, crn: string) => `${term}:${crn}`;

function indexSeats(seats: SeatInfo[], previous: Record<string, SeatInfo>) {
  const next: Record<string, SeatInfo> = { ...previous };
  const flash: Record<string, number> = {};
  const now = Date.now();
  for (const seat of seats) {
    const key = seatKey(seat.term, seat.crn);
    const before = previous[key];
    if (before && before.available !== seat.available) flash[key] = now;
    next[key] = seat;
  }
  return { next, flash };
}

function applySnapshot(snapshot: Snapshot) {
  const { next } = indexSeats(snapshot.seats, {});
  set({
    status: snapshot.status,
    settings: snapshot.settings,
    wanted: sortWanted(snapshot.wanted),
    seats: next,
    approvals: snapshot.approvals,
    events: [...snapshot.events].sort((a, b) => b.id - a.id).slice(0, EVENT_CAP),
    terms: snapshot.terms,
    loadError: null,
  });
}

function sortPlans(list: Plan[]) {
  return [...list].sort((a, b) => a.position - b.position || a.id - b.id);
}

function sortWanted(list: WantedCourse[]) {
  return [...list].sort((a, b) => a.priority - b.priority || a.id - b.id);
}

export function apply(message: StreamMessage) {
  switch (message.type) {
    case "hello":
      applySnapshot(message.snapshot);
      break;
    case "event": {
      if (state.events.some(e => e.id === message.event.id)) return;
      set({ events: [message.event, ...state.events].slice(0, EVENT_CAP) });
      break;
    }
    case "status":
      set({ status: message.status });
      break;
    case "seats": {
      const { next, flash } = indexSeats(message.seats, state.seats);
      set({ seats: next, seatFlash: Object.keys(flash).length ? { ...state.seatFlash, ...flash } : state.seatFlash });
      break;
    }
    case "wanted":
      set({ wanted: sortWanted(message.wanted) });
      break;
    case "approvals":
      set({ approvals: message.approvals });
      break;
    case "settings":
      set({ settings: message.settings });
      break;
    case "plans":
      set({ plans: { ...state.plans, [message.term]: sortPlans(message.plans) } });
      break;
  }
}

/** Optimistic local updates after a mutation returns. The stream will confirm. */
export const local = {
  upsertWanted(course: WantedCourse) {
    const exists = state.wanted.some(w => w.id === course.id);
    set({ wanted: sortWanted(exists ? state.wanted.map(w => (w.id === course.id ? course : w)) : [...state.wanted, course]) });
  },
  removeWanted(id: number) {
    set({ wanted: state.wanted.filter(w => w.id !== id) });
  },
  reorder(ids: number[]) {
    const byId = new Map(state.wanted.map(w => [w.id, w]));
    const next = ids.map((id, i) => ({ ...byId.get(id)!, priority: i })).filter(w => w.id !== undefined);
    set({ wanted: next });
  },
  settings(settings: PublicSettings) {
    set({ settings });
  },
  plans(term: string, plans: Plan[]) {
    set({ plans: { ...state.plans, [term]: sortPlans(plans) } });
  },
  upsertPlan(plan: Plan) {
    const list = state.plans[plan.term] ?? [];
    const exists = list.some(p => p.id === plan.id);
    local.plans(plan.term, exists ? list.map(p => (p.id === plan.id ? plan : p)) : [...list, plan]);
  },
  removePlan(term: string, id: number) {
    local.plans(term, (state.plans[term] ?? []).filter(p => p.id !== id));
  },
  globalPaused(paused: boolean) {
    if (!state.status) return;
    set({ status: { ...state.status, globalPaused: paused } });
  },
};

let source: EventSource | null = null;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let mockStreamStarted = false;

function stopStream() {
  source?.close();
  source = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function connectStream() {
  if (isMock) return;
  source?.close();
  const es = new EventSource("/api/stream");
  source = es;
  es.onopen = () => {
    retry = 0;
    set({ connection: "open" });
  };
  es.onmessage = ev => {
    try {
      apply(JSON.parse(ev.data) as StreamMessage);
    } catch (error) {
      console.error("bad stream frame", error);
    }
  };
  es.onerror = async () => {
    es.close();
    if (source !== es) return;
    source = null;
    set({ connection: "reconnecting" });
    // EventSource hides the status code. A revoked session looks like any other drop, so ask.
    try {
      const auth = await api.authStatus();
      setAuthStatus(auth);
      if (auth.mode === "password" && !auth.authenticated) return;
    } catch {
      // Server unreachable. Keep retrying below.
    }
    const delay = Math.min(30_000, 1000 * 2 ** retry) + Math.random() * 500;
    retry += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connectStream, delay);
  };
}

/** Ask whether this browser may use the app. Starts the store when it may. */
export async function boot() {
  try {
    setAuthStatus(await api.authStatus());
  } catch (error) {
    // An unreachable server shows the normal load error once start() runs.
    setAuthStatus({ mode: null, authenticated: true, passkeyLogin: false, passkeysSupported: false, recoveryCodesLeft: null });
    set({ loadError: errorMessage(error) });
  }
  if (getAuth().gate === "ok") await start();
}

export async function start() {
  if (started) return;
  started = true;
  try {
    applySnapshot(await api.state());
    set({ connection: isMock ? "open" : "connecting" });
  } catch (error) {
    if (getAuth().gate === "signin") {
      started = false;
      return;
    }
    set({ loadError: errorMessage(error) });
  }
  if (isMock) {
    if (!mockStreamStarted) {
      mockStreamStarted = true;
      const mock = await import("../dev/mock");
      mock.startMockStream(apply);
    }
    set({ connection: "open" });
    return;
  }
  connectStream();
}

/** Back to the sign-in screen: drop the stream and the loaded state. */
export function signedOut() {
  stopStream();
  started = false;
  state = { ...state, status: null, settings: null, wanted: [], approvals: [], events: [], plans: {}, connection: "connecting", loadError: null };
  for (const listener of listeners) listener();
}

onSignOut(() => signedOut());

export async function reload() {
  try {
    applySnapshot(await api.state());
  } catch (error) {
    set({ loadError: errorMessage(error) });
  }
}

export function seatFor(s: ClientState, term: string, crn: string): SeatInfo | undefined {
  return s.seats[seatKey(term, crn)];
}
