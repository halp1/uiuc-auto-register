import type { Bus } from "../core/bus";
import type { Config } from "../core/config";
import type { CatalogService, ControlApi, Notifier, OrchestratorApi, PollerApi, RehearsalReport, SessionManager, SimBannerApi, TicketApi } from "../core/contracts";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import type { CourseDetail, PublicSettings, SearchHit, Settings, SystemStatus, Term } from "../core/types";

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
  terms(): Promise<Term[]>;
  status(): SystemStatus;
  settings(): Settings;
  /** Apply a settings change from the UI and propagate to dependent components. */
  applySettings(patch: Partial<Settings>): PublicSettings;
  rehearse(term: string): Promise<RehearsalReport>;
  discordStatus(): { state: string; detail: string | null };
}
