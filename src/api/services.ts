import type { Bus } from "../core/bus";
import type { Config } from "../core/config";
import type { CatalogService, ControlApi, Notifier, OrchestratorApi, PollerApi, RehearsalReport, SessionManager, SimBannerApi, TicketApi } from "../core/contracts";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import type {
  CourseDetail,
  Plan,
  PlanGenerateResult,
  PlanPick,
  PublicSettings,
  SearchHit,
  Settings,
  SystemStatus,
  Term,
  TicketDetectResult,
  WantedCourse,
} from "../core/types";

/** Everything the HTTP layer needs. Built in src/app.ts. */
export interface AppServices {
  config: Config;
  store: Store;
  bus: Bus;
  events: Events;
  poller: PollerApi;
  orchestrator: OrchestratorApi;
  ticket: TicketApi;
  session: SessionManager | null; // null in simulated mode
  notifier: Notifier;
  control: ControlApi;
  catalog: CatalogService;
  sim: SimBannerApi | null; // only in simulated mode
  search(term: string, q: string): SearchHit[];
  courseDetail(term: string, subject: string, number: string): Promise<CourseDetail | null>;
  /** Catalog title only: local store first, Course Explorer when missing. No seat or linked lookups. */
  courseTitle(term: string, subject: string, number: string): Promise<string | null>;
  /** Schedule planner. Both throw PlanError (src/engine/plans.ts) with an HTTP status. */
  planGenerate(planId: number): Promise<PlanGenerateResult>;
  planTarget(planId: number, picks: PlanPick[]): Promise<{ plan: Plan; wanted: WantedCourse[] }>;
  terms(): Promise<Term[]>;
  status(): SystemStatus;
  settings(): Settings;
  /** Apply a settings change from the UI and propagate to dependent components. */
  applySettings(patch: Partial<Settings>): PublicSettings;
  rehearse(term: string): Promise<RehearsalReport>;
  /** Read the time ticket from Banner and apply it. Throws TicketDetectError with an HTTP status. */
  detectTicket(term: string): Promise<TicketDetectResult>;
  discordStatus(): { state: string; detail: string | null };
}
