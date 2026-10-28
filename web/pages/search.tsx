import { ChevronRight, RefreshCw, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "../../src/core/types";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/input";
import { InlineError, PageHeader } from "@/components/ui/list";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { relative, termName, useNow } from "@/lib/format";
import { coursePath, hrefWithMock, linkClick, navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

export function SearchPage({ initialQuery }: { initialQuery: string }) {
  const term = useStore(s => s.settings?.activeTerm ?? null);
  const terms = useStore(s => s.terms);
  const catalog = useStore(s => s.status!.catalog);
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNow(30_000);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const catalogEmpty = catalog.term === term && catalog.courses === 0;
  const query = q.trim();

  useEffect(() => {
    // Keep ?q= in the URL so back and refresh restore the search.
    navigate(`/search${query ? `?q=${encodeURIComponent(query)}` : ""}`, { replace: true });
  }, [query]);

  useEffect(() => {
    if (!term || !query) {
      setHits(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await api.search(term, query);
        if (cancelled) return;
        setHits(res);
        setActive(0);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [term, query, catalog.syncedAt]);

  async function sync() {
    if (!term) return;
    setSyncBusy(true);
    setSyncError(null);
    try {
      await api.syncCatalog(term);
    } catch (e) {
      setSyncError(errorMessage(e));
    } finally {
      setSyncBusy(false);
    }
  }

  function open(hit: SearchHit) {
    navigate(coursePath(hit.term, hit.subject, hit.number));
  }

  const listId = "search-results";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Search">
        <span className="text-[0.8125rem] text-fg-muted">{termName(terms, term)}</span>
      </PageHeader>

      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          id="search-input"
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={!!hits && hits.length > 0}
          aria-controls={listId}
          aria-activedescendant={hits && hits[active] ? `hit-${active}` : undefined}
          aria-label="Search courses by code, title, instructor, or CRN"
          autoComplete="off"
          spellCheck={false}
          placeholder="CS 225, Data Structures, an instructor, or a CRN"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            if (!hits || hits.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(a => Math.min(hits.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(a => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = hits[active];
              if (hit) open(hit);
            }
          }}
          disabled={!term}
          className="h-14 w-full rounded-lg border border-border-strong bg-surface pl-12 pr-16 text-base text-fg placeholder:text-placeholder transition-[border-color,box-shadow] duration-150 ease-out hover:border-border-hover focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50 [&::-webkit-search-cancel-button]:hidden"
        />
        <Kbd aria-hidden className="absolute right-4 top-1/2 -translate-y-1/2">
          Enter
        </Kbd>
      </div>

      {!term && <p className="text-sm text-fg-muted">Choose a term in the top bar first.</p>}

      {term && (catalogEmpty || catalog.syncing) && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-5 sm:flex-row sm:items-center">
          <div className="flex-1">
            <p className="text-sm font-medium">
              {catalog.syncing ? "Syncing the catalog" : `No catalog for ${termName(terms, term)} yet`}
            </p>
            <p className="mt-0.5 text-[0.8125rem] text-fg-muted">
              {catalog.syncing ? "Search fills in when it finishes." : "Search needs a one time sync from Course Explorer."}
            </p>
            <InlineError className="mt-1">{syncError}</InlineError>
          </div>
          <Button variant="primary" size="sm" onClick={sync} loading={syncBusy || catalog.syncing}>
            {!(syncBusy || catalog.syncing) && <RefreshCw aria-hidden />}
            Sync catalog
          </Button>
        </div>
      )}

      <InlineError>{error}</InlineError>

      {loading && !hits && <ResultsSkeleton />}

      {hits && hits.length === 0 && !loading && (
        <div className="rounded-lg border border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">No courses match "{query}"</p>
          <p className="mt-1 text-[0.8125rem] text-fg-muted">Try a subject and number like CS 225, or a five digit CRN.</p>
        </div>
      )}

      {hits && hits.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Results"
          className={cn(
            "overflow-hidden rounded-lg border border-border bg-surface transition-opacity duration-150 [&>*+*]:border-t [&>*+*]:border-border",
            loading && "opacity-60",
          )}
        >
          {hits.map((hit, i) => {
            const href = coursePath(hit.term, hit.subject, hit.number);
            return (
              <li key={`${hit.subject}${hit.number}`} id={`hit-${i}`} role="option" aria-selected={i === active}>
                <a
                  href={hrefWithMock(href)}
                  onClick={linkClick(href)}
                  onMouseEnter={() => setActive(i)}
                  tabIndex={-1}
                  className={cn(
                    "grid min-h-14 grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors duration-150 ease-out sm:grid-cols-[110px_minmax(0,1fr)_auto_auto_auto]",
                    i === active && "bg-hover",
                  )}
                >
                  <span className="font-mono text-sm font-medium">
                    {hit.subject} {hit.number}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{hit.title}</span>
                    {(hit.matchedCrn || hit.matchedInstructor) && (
                      <span className="block truncate text-xs text-fg-muted">
                        {hit.matchedCrn ? (
                          <>
                            CRN <span className="font-mono text-fg">{hit.matchedCrn}</span>
                          </>
                        ) : (
                          hit.matchedInstructor
                        )}
                      </span>
                    )}
                  </span>
                  <span className="hidden text-[0.8125rem] text-fg-muted tabular-nums sm:block">
                    {hit.creditHours ? `${hit.creditHours} hrs` : ""}
                  </span>
                  <span className="hidden text-[0.8125rem] text-fg-muted tabular-nums sm:block">
                    {hit.sectionCount} {hit.sectionCount === 1 ? "section" : "sections"}
                  </span>
                  <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {term && catalog.term === term && catalog.syncedAt && !catalog.syncing && (
        <p className="text-xs text-fg-subtle tabular-nums">
          {catalog.courses} courses, synced {relative(catalog.syncedAt, now)}
        </p>
      )}
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div aria-busy aria-label="Searching" className="overflow-hidden rounded-lg border border-border">
      {[0, 1, 2, 3, 4].map(i => (
        <div key={i} className="flex h-14 items-center gap-4 border-b border-border px-4 last:border-b-0">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 flex-1 max-w-64" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
