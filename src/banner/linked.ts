// Linked sections ("must also add one of these options") from Banner's anonymous class search.

import type { Store } from "../core/db";
import { BANNER_BASE, MEP_CODE, looksLikeLogin, type FetchLike } from "./enrollment";

export const LINKED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the getLinkedSections fragment into options; each option lists the CRNs that must be added
 * together with the queried CRN. Returns null if the fragment is not a linked-sections page.
 */
export function parseLinkedSections(html: string): string[][] | null {
  if (!/aria-labelledby="linked"|Linked Sections|No linked course information/i.test(html)) return null;
  if (/No linked course information available/i.test(html)) return [];
  const options: string[][] = [];
  // Split on option headings; chunk 0 is the preamble.
  const chunks = html.split(/<div[^>]*class="[^"]*linkedSectionsAddAll[^"]*"[^>]*>\s*Option\s+\d+\s*<\/div>/i);
  for (const chunk of chunks.slice(1)) {
    const crns: string[] = [];
    const body = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(chunk)?.[1] ?? chunk;
    for (const row of body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]!.replace(/<[^>]+>/g, "").trim());
      const crn = cells[3];
      if (crn && /^\d{5}$/.test(crn)) crns.push(crn);
    }
    if (crns.length) options.push(crns);
  }
  return options;
}

export interface LinkedFetcherOptions {
  fetch?: FetchLike;
  base?: string;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export class LinkedSections {
  private fetchImpl: FetchLike;
  private base: string;
  private now: () => number;
  private ttlMs: number;
  private timeoutMs: number;
  private inflight = new Map<string, Promise<string[][] | null>>();

  constructor(
    private store: Store,
    options: LinkedFetcherOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = options.base ?? BANNER_BASE;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? LINKED_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  /** Cached options without fetching (null when unknown). */
  cached(term: string, crn: string): { options: string[][]; fetchedAt: number } | null {
    const row = this.store.db.query("SELECT options, fetched_at FROM linked_options WHERE term = ? AND crn = ?").get(term, crn) as
      | { options: string; fetched_at: number }
      | null;
    return row ? { options: JSON.parse(row.options), fetchedAt: row.fetched_at } : null;
  }

  save(term: string, crn: string, options: string[][]): void {
    this.store.db
      .query(
        `INSERT INTO linked_options (term, crn, options, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(term, crn) DO UPDATE SET options = excluded.options, fetched_at = excluded.fetched_at`,
      )
      .run(term, crn, JSON.stringify(options), this.now());
  }

  /** Linked options for a CRN, from cache when fresh, otherwise fetched. Null when unavailable. */
  async get(term: string, crn: string, opts: { force?: boolean } = {}): Promise<string[][] | null> {
    const cached = this.cached(term, crn);
    if (cached && !opts.force && this.now() - cached.fetchedAt < this.ttlMs) return cached.options;
    const key = `${term}:${crn}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetchRemote(term, crn).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const fresh = await pending;
    if (fresh) {
      this.save(term, crn, fresh);
      return fresh;
    }
    return cached?.options ?? null;
  }

  /** Fetch several CRNs sequentially (polite), returning crn -> options for those that resolved. */
  async getMany(term: string, crns: string[]): Promise<Record<string, string[][]>> {
    const out: Record<string, string[][]> = {};
    for (const crn of crns) {
      const options = await this.get(term, crn);
      if (options) out[crn] = options;
    }
    return out;
  }

  private async fetchRemote(term: string, crn: string): Promise<string[][] | null> {
    const params = new URLSearchParams({ term, courseReferenceNumber: crn, mepCode: MEP_CODE });
    try {
      const response = await this.fetchImpl(`${this.base}/searchResults/getLinkedSections?${params}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) return null;
      const html = await response.text();
      if (looksLikeLogin(html)) return null;
      return parseLinkedSections(html);
    } catch {
      return null;
    }
  }
}
