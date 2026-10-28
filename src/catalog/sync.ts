// CatalogService: Banner term list plus a polite daily Course Explorer sync into SQLite.

import type { CatalogService } from "../core/contracts";
import type { Store } from "../core/db";
import type { Events } from "../core/events";
import { isTermCode, termLabel } from "../core/terms";
import type { Term } from "../core/types";
import { BANNER_BASE, MEP_CODE, type FetchLike } from "../banner/enrollment";
import { Explorer } from "./explorer";
import { catalogMeta, courseCount, replaceSubject, setCatalogMeta } from "./store";

export const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TERMS_TTL_MS = 6 * 60 * 60 * 1000;

/** "Spring 2027 - Urbana-Champaign" -> "Spring 2027"; odd winter wording falls back to termLabel. */
export function cleanTermDescription(code: string, description: string): string {
  const stripped = description.replace(/\s*-\s*Urbana-Champaign\s*$/i, "").trim();
  if (/^(Spring|Summer|Fall|Winter) \d{4}$/.test(stripped)) return stripped;
  try {
    return termLabel(code);
  } catch {
    return stripped || code;
  }
}

export function parseTerms(json: unknown): Term[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((entry): entry is { code: string; description: string } => isTermCode(entry?.code) && typeof entry?.description === "string")
    .map(entry => ({ code: entry.code, description: cleanTermDescription(entry.code, entry.description) }));
}

export interface CatalogSyncDeps {
  store: Store;
  events?: Events;
  explorer?: Explorer;
  fetch?: FetchLike;
  bannerBase?: string;
  /** Gap between subject requests. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class CatalogSync implements CatalogService {
  private store: Store;
  private events: Events | undefined;
  private explorer: Explorer;
  private fetchImpl: FetchLike;
  private bannerBase: string;
  private gapMs: number;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private running: Promise<{ courses: number }> | null = null;
  private runningTerm: string | null = null;
  private termsCache: { at: number; terms: Term[] } | null = null;

  constructor(deps: CatalogSyncDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.explorer = deps.explorer ?? new Explorer({ fetch: this.fetchImpl });
    this.bannerBase = deps.bannerBase ?? BANNER_BASE;
    this.gapMs = deps.gapMs ?? 250;
    this.sleep = deps.sleep ?? (ms => Bun.sleep(ms));
    this.now = deps.now ?? Date.now;
  }

  async terms(): Promise<Term[]> {
    if (this.termsCache && this.now() - this.termsCache.at < TERMS_TTL_MS) return this.termsCache.terms;
    try {
      const params = new URLSearchParams({ offset: "1", max: "10", searchTerm: "", mepCode: MEP_CODE });
      const response = await this.fetchImpl(`${this.bannerBase}/classSearch/getTerms?${params}`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const terms = parseTerms(await response.json());
      if (!terms.length) throw new Error("empty term list");
      this.termsCache = { at: this.now(), terms };
      return terms;
    } catch {
      return this.termsCache?.terms ?? this.fallbackTerms();
    }
  }

  /** Terms derived from the calendar when Banner cannot be reached. */
  private fallbackTerms(): Term[] {
    const date = new Date(this.now());
    const year = date.getUTCFullYear();
    const codes = [`1${year + 1}1`, `1${year}8`, `1${year}5`, `1${year}1`];
    return codes.map(code => ({ code, description: termLabel(code) }));
  }

  syncing(): boolean {
    return this.running !== null;
  }

  private dailyTimer: ReturnType<typeof setInterval> | null = null;

  /** Check hourly and sync the active term once its catalog is a day old. Also checks right away. */
  startDaily(activeTerm: () => string | null, checkEveryMs = 60 * 60 * 1000): void {
    this.stopDaily();
    const check = () => {
      const term = activeTerm();
      if (term && isTermCode(term) && !this.syncing() && this.isStale(term)) {
        this.sync(term).catch(error => console.error("catalog sync failed", error));
      }
    };
    check();
    this.dailyTimer = setInterval(check, checkEveryMs);
  }

  stopDaily(): void {
    if (this.dailyTimer) clearInterval(this.dailyTimer);
    this.dailyTimer = null;
  }

  /** Status block for SystemStatus.catalog. */
  status(term: string | null): { term: string | null; syncedAt: number | null; courses: number; syncing: boolean } {
    const meta = term ? catalogMeta(this.store, term) : null;
    return {
      term,
      syncedAt: meta?.syncedAt ?? null,
      courses: term ? courseCount(this.store, term) : 0,
      syncing: this.syncing(),
    };
  }

  /** True when the term has never synced or the last sync is older than a day. */
  isStale(term: string): boolean {
    const meta = catalogMeta(this.store, term);
    return !meta || this.now() - meta.syncedAt >= SYNC_MAX_AGE_MS;
  }

  async sync(term: string, opts: { force?: boolean } = {}): Promise<{ courses: number }> {
    if (!isTermCode(term)) throw new Error(`Invalid term code: ${term}`);
    if (this.running) {
      if (this.runningTerm === term) return this.running;
      await this.running.catch(() => undefined);
    }
    if (!opts.force && !this.isStale(term)) return { courses: courseCount(this.store, term) };
    this.runningTerm = term;
    this.running = this.run(term).finally(() => {
      this.running = null;
      this.runningTerm = null;
    });
    return this.running;
  }

  private async run(term: string): Promise<{ courses: number }> {
    const started = this.now();
    const subjects = await this.explorer.subjects(term);
    if (!subjects.length) throw new Error(`Course Explorer lists no subjects for ${termLabel(term)}`);
    const failed: string[] = [];
    for (let i = 0; i < subjects.length; i++) {
      const subject = subjects[i]!;
      if (i > 0) await this.sleep(this.gapMs);
      try {
        const courses = await this.explorer.subjectCascade(term, subject.code);
        replaceSubject(this.store, term, subject.code, courses);
      } catch {
        failed.push(subject.code);
      }
    }
    if (failed.length === subjects.length) throw new Error("Course Explorer sync failed for every subject");
    const courses = setCatalogMeta(this.store, term, this.now());
    this.events?.emit({
      kind: "catalog_synced",
      severity: failed.length ? "warning" : "info",
      title: `Catalog synced for ${termLabel(term)}`,
      detail: `${courses} courses from ${subjects.length - failed.length} subjects in ${Math.round((this.now() - started) / 1000)} s${
        failed.length ? `. Failed: ${failed.join(", ")}` : ""
      }`,
      payload: { term, courses, failed },
    });
    return { courses };
  }
}
