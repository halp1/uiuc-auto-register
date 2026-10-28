import { Check, ListFilter, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { AppEvent, EventKind, Severity } from "../../src/core/types";
import { EventRow, severityLabel, severityTone } from "@/components/data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FilterChip, InlineError, PageHeader } from "@/components/ui/list";
import { Dot } from "@/components/ui/status-dot";
import { api } from "@/lib/api";
import { useNow } from "@/lib/format";
import { useStore } from "@/lib/store";
import { errorMessage } from "@/lib/utils";

const SEVERITIES: Severity[] = ["critical", "warning", "success", "info"];

const kindLabels: Record<EventKind, string> = {
  bundle_opened: "Seat opened",
  approval_needed: "Approval needed",
  registered: "Registered",
  registration_failed: "Registration failed",
  session_error: "Session error",
  guard_tripped: "Guard tripped",
  poller_degraded: "Poller degraded",
  restarted: "Restarted",
  seat_changed: "Seat changed",
  approval_resolved: "Approval resolved",
  attempt: "Attempt",
  login_stage: "Login",
  session_state: "Session",
  rehearsal_result: "Rehearsal",
  settings_changed: "Settings",
  control: "Control",
  catalog_synced: "Catalog",
  info: "Info",
};

const PAGE = 50;

function toggle<T>(list: T[], v: T) {
  return list.includes(v) ? list.filter(x => x !== v) : [...list, v];
}

export function ActivityPage() {
  const now = useNow(15_000);
  const live = useStore(s => s.events);
  const [older, setOlder] = useState<AppEvent[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [kinds, setKinds] = useState<EventKind[]>([]);

  const all = useMemo(() => {
    const seen = new Set<number>();
    const out: AppEvent[] = [];
    for (const e of [...live, ...older]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out.sort((a, b) => b.id - a.id);
  }, [live, older]);

  const presentKinds = useMemo(() => {
    const set = new Set<EventKind>(all.map(e => e.kind));
    for (const k of kinds) set.add(k);
    return [...set].sort((a, b) => kindLabels[a].localeCompare(kindLabels[b]));
  }, [all, kinds]);

  const shown = all.filter(
    e => (severities.length === 0 || severities.includes(e.severity)) && (kinds.length === 0 || kinds.includes(e.kind)),
  );

  async function loadMore() {
    const oldest = all[all.length - 1];
    setLoading(true);
    setError(null);
    try {
      const page = await api.events(oldest ? oldest.id : null, PAGE);
      setOlder(o => [...o, ...page]);
      if (page.length < PAGE) setDone(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  const filtered = severities.length > 0 || kinds.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activity" />

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filters">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterChip active={severities.length > 0}>
              <ListFilter aria-hidden />
              Severity
              {severities.length > 0 && (
                <span className="text-fg-muted tabular-nums">
                  {severities.length === 1 ? severityLabel[severities[0]!] : severities.length}
                </span>
              )}
            </FilterChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Severity</DropdownMenuLabel>
            {SEVERITIES.map(s => (
              <DropdownMenuItem
                key={s}
                onSelect={e => {
                  e.preventDefault();
                  setSeverities(v => toggle(v, s));
                }}
                role="menuitemcheckbox"
                aria-checked={severities.includes(s)}
              >
                <Dot tone={severityTone[s]} />
                <span className="flex-1">{severityLabel[s]}</span>
                {severities.includes(s) && <Check className="!text-fg" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <FilterChip active={kinds.length > 0}>
              <ListFilter aria-hidden />
              Kind
              {kinds.length > 0 && (
                <span className="text-fg-muted tabular-nums">{kinds.length === 1 ? kindLabels[kinds[0]!] : kinds.length}</span>
              )}
            </FilterChip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            <DropdownMenuLabel>Kind</DropdownMenuLabel>
            {presentKinds.map(k => (
              <DropdownMenuItem
                key={k}
                onSelect={e => {
                  e.preventDefault();
                  setKinds(v => toggle(v, k));
                }}
                role="menuitemcheckbox"
                aria-checked={kinds.includes(k)}
              >
                <span className="flex-1">{kindLabels[k]}</span>
                {kinds.includes(k) && <Check className="!text-fg" aria-hidden />}
              </DropdownMenuItem>
            ))}
            {kinds.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setKinds([])}>Clear</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {filtered && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setSeverities([]);
              setKinds([]);
            }}
          >
            <X aria-hidden />
            Clear filters
          </Button>
        )}
        <span className="ml-auto text-xs text-fg-subtle tabular-nums">
          {shown.length} of {all.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-border px-6 py-12 text-center">
          <p className="text-sm font-medium">{filtered ? "No events match these filters" : "No events yet"}</p>
          {!filtered && <p className="mt-1 text-[0.8125rem] text-fg-muted">Seat changes, logins, and registrations land here.</p>}
        </div>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-border bg-surface [&>*+*]:border-t [&>*+*]:border-border">
          {shown.map(e => (
            <EventRow key={e.id} event={e} now={now} />
          ))}
        </ol>
      )}

      <div className="flex flex-col items-center gap-2">
        <InlineError>{error}</InlineError>
        {!done ? (
          <Button variant="secondary" size="sm" onClick={loadMore} loading={loading}>
            Load more
          </Button>
        ) : (
          <p className="text-xs text-fg-subtle">Start of history</p>
        )}
      </div>
    </div>
  );
}
