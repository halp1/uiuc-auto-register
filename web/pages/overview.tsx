import {
  ArrowDown,
  ArrowUp,
  Ellipsis,
  GripVertical,
  ListRestart,
  LogIn,
  OctagonAlert,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import type { Approval, WantedCourse } from "../../src/core/types";
import { ConfirmDialog } from "@/components/confirm";
import { BundleChip, CourseState, EventRow, SeatCount } from "@/components/data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineError, List, ListRow, PageHeader } from "@/components/ui/list";
import { Status, type Tone } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { countdown, courseCode, courseDisplayState, formatDateTime, modeLabel, relative, useNow } from "@/lib/format";
import { coursePath, hrefWithMock, linkClick, navigate } from "@/lib/router";
import { local, seatKey, useStore, type ClientState } from "@/lib/store";
import { cn, errorMessage } from "@/lib/utils";

// ---------- status row ----------

const pollerMeta: Record<string, { tone: Tone; label: string }> = {
  idle: { tone: "off", label: "Idle" },
  running: { tone: "ready", label: "Running" },
  backoff: { tone: "warning", label: "Backing off" },
  degraded: { tone: "warning", label: "Degraded" },
  paused: { tone: "off", label: "Paused" },
};

const sessionMeta: Record<string, { tone: Tone; label: string }> = {
  cold: { tone: "off", label: "Cold" },
  logging_in: { tone: "warning", label: "Logging in" },
  warm: { tone: "ready", label: "Warm" },
  paused: { tone: "off", label: "Paused" },
  error: { tone: "error", label: "Error" },
};

function Cell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 px-4 py-3.5", className)}>
      <span className="text-xs text-fg-muted">{label}</span>
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">{children}</div>
    </div>
  );
}

function StatusRow({ now }: { now: number }) {
  const status = useStore(s => s.status)!;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const poller = status.globalPaused ? pollerMeta.paused! : pollerMeta[status.poller.state]!;
  const session = sessionMeta[status.session.state]!;
  const simulated = status.mode === "simulated";
  const ticketAt = status.ticket.at ? new Date(status.ticket.at).getTime() : null;
  const pausedUntil = status.session.pausedUntil;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface lg:grid-cols-4 [&>*]:border-border max-lg:[&>*:nth-child(odd)]:border-r max-lg:[&>*:nth-child(-n+2)]:border-b lg:[&>*+*]:border-l">
        <Cell label="Poller">
          <Status tone={poller.tone} pulse={poller.label === "Running"}>
            {poller.label}
          </Status>
          <span className="text-fg-muted tabular-nums">every {status.poller.intervalSec}s</span>
          <span className="text-xs text-fg-subtle tabular-nums">{relative(status.poller.lastCycleAt, now)}</span>
        </Cell>
        <Cell label="Session">
          {simulated ? (
            <Status tone="off" className="whitespace-normal text-fg-muted">
              Not used
            </Status>
          ) : (
          <>
          <Status tone={session.tone} pulse={status.session.state === "logging_in"}>
            {status.session.state === "logging_in" && status.session.stage ? status.session.stage : session.label}
          </Status>
          {status.session.state === "paused" && pausedUntil && (
            <span className="text-xs text-fg-muted tabular-nums">{countdown(pausedUntil, now)} left</span>
          )}
          <span className="flex min-w-0 flex-wrap gap-1.5 max-sm:basis-full">
            {(status.session.state === "cold" || status.session.state === "error") && (
              <Button size="xs" onClick={() => run("login", api.login)} loading={busy === "login"}>
                {busy !== "login" && <LogIn aria-hidden />}
                Log in
              </Button>
            )}
            {status.session.state === "paused" ? (
              <Button size="xs" onClick={() => run("resume", () => api.pauseSession(null))} loading={busy === "resume"}>
                {busy !== "resume" && <Play aria-hidden />}
                Resume
              </Button>
            ) : (
              status.session.state !== "logging_in" && (
                <Button size="xs" variant="ghost" onClick={() => run("pause", () => api.pauseSession(30))} loading={busy === "pause"}>
                  {busy !== "pause" && <Pause aria-hidden />}
                  Pause 30 min
                </Button>
              )
            )}
          </span>
          </>
          )}
        </Cell>
        <Cell label="Next ticket">
          {ticketAt && ticketAt > now ? (
            <>
              <span className="font-mono tabular-nums">{countdown(ticketAt, now)}</span>
              <span className="text-xs text-fg-muted">{formatDateTime(ticketAt)}</span>
            </>
          ) : ticketAt ? (
            <span className="text-fg-muted">Window open</span>
          ) : (
            <a
              href={hrefWithMock("/settings#ticket")}
              onClick={linkClick("/settings#ticket")}
              className="text-fg-muted underline decoration-border-hover hover:text-fg"
            >
              Not set
            </a>
          )}
        </Cell>
        <Cell label="Mode">
          <Status tone={status.mode === "live" && status.liveEnabled ? "accent" : status.mode === "live" ? "warning" : "neutral"}>
            {modeLabel[status.mode]}
            {status.mode === "live" && !status.liveEnabled ? " (off)" : ""}
          </Status>
          {status.mode === "simulated" && <span className="text-xs text-fg-muted">Nothing real happens</span>}
        </Cell>
      </div>
      <InlineError>{error}</InlineError>
      {status.session.state === "error" && status.session.lastError && (
        <p role="alert" className="text-[0.8125rem] text-error-fg">
          {status.session.lastError}
        </p>
      )}
    </div>
  );
}

// ---------- guard banner ----------

function GuardBanner() {
  const guard = useStore(s => s.status?.guardTripped ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!guard) return null;
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-[#5c1f1f] bg-[#130606] p-4 sm:flex-row sm:items-start">
      <OctagonAlert className="size-5 shrink-0 text-error-fg" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-fg">Registration halted by the safety guard</p>
        <p className="mt-1 text-[0.8125rem] text-[#e3b3b3]">{guard.detail}</p>
        <p className="mt-1 text-xs text-[#c08a8a] tabular-nums">{formatDateTime(guard.at)}</p>
        <InlineError className="mt-2">{error}</InlineError>
      </div>
      <Button
        variant="primary"
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.clearGuard();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Clear and resume
      </Button>
    </div>
  );
}

// ---------- approvals ----------

function ApprovalRow({ approval, now }: { approval: Approval; now: number }) {
  const [busy, setBusy] = useState<"approve" | "skip" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seats = useStore(s => s.seats);

  async function act(kind: "approve" | "skip") {
    setBusy(kind);
    setError(null);
    try {
      const res = kind === "approve" ? await api.approve(approval.id) : await api.skip(approval.id);
      if (!res.ok) setError(res.detail);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const term = useStore(s => s.wanted.find(w => w.id === approval.courseId)?.term ?? s.settings?.activeTerm ?? "");

  return (
    <ListRow className="flex-wrap gap-y-2.5">
      <Status tone="violet" pulse className="text-[0.8125rem] text-violet-fg">
        Approve
      </Status>
      <div className="min-w-0 flex-1 max-sm:order-first max-sm:basis-full">
        <p className="font-mono text-sm sm:truncate">{approval.label}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
          {approval.crns.map(crn => (
            <span key={crn} className="inline-flex items-center gap-1.5 font-mono text-xs text-fg-muted">
              {crn}
              <SeatCount seat={seats[seatKey(term, crn)]} className="[&_.font-mono]:text-xs" />
            </span>
          ))}
        </p>
        <InlineError className="mt-1">{error}</InlineError>
      </div>
      {approval.autoAt && (
        <span className="text-xs text-fg-muted tabular-nums" aria-live="off">
          Auto in <span className="font-mono text-fg">{countdown(approval.autoAt, now)}</span>
        </span>
      )}
      <div className="flex gap-2 max-sm:ml-auto">
        <Button size="sm" variant="secondary" onClick={() => act("skip")} loading={busy === "skip"} disabled={busy === "approve"}>
          Skip
        </Button>
        <Button size="sm" variant="primary" onClick={() => act("approve")} loading={busy === "approve"} disabled={busy === "skip"}>
          Register
        </Button>
      </div>
    </ListRow>
  );
}

// ---------- watchlist ----------

const lastChecked = (course: WantedCourse, s: ClientState) => {
  let max = 0;
  for (const b of course.bundles)
    for (const crn of b.crns) {
      const seat = s.seats[seatKey(course.term, crn)];
      if (seat && seat.checkedAt > max) max = seat.checkedAt;
    }
  return max || null;
};

function WatchRow({
  course,
  index,
  count,
  now,
  onMove,
  dragging,
  dragOver,
  dragHandlers,
}: {
  course: WantedCourse;
  index: number;
  count: number;
  now: number;
  onMove: (from: number, to: number) => void;
  dragging: boolean;
  dragOver: boolean;
  dragHandlers: {
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
}) {
  const seats = useStore(s => s.seats);
  const seatFlash = useStore(s => s.seatFlash);
  const checked = useStore(s => lastChecked(course, s));
  const [armBusy, setArmBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [optimisticArmed, setOptimisticArmed] = useState<boolean | null>(null);
  const armed = optimisticArmed ?? course.armed;
  const display = courseDisplayState({ ...course, armed });
  const seatOf = (crn: string) => seats[seatKey(course.term, crn)];
  const href = coursePath(course.term, course.subject, course.number);

  const flashKeys = new Set<string>();
  let flashTs = 0;
  for (const b of course.bundles)
    for (const crn of b.crns) {
      const t = seatFlash[seatKey(course.term, crn)];
      if (t && now - t < 1500) {
        flashKeys.add(crn);
        if (t > flashTs) flashTs = t;
      }
    }

  async function setArmed(next: boolean) {
    setArmBusy(true);
    setError(null);
    setOptimisticArmed(next);
    try {
      local.upsertWanted(next ? await api.arm(course.id) : await api.disarm(course.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOptimisticArmed(null);
      setArmBusy(false);
    }
  }

  async function reset() {
    setError(null);
    try {
      local.upsertWanted(await api.reset(course.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const code = courseCode(course);
  const visibleBundles = course.bundles.slice(0, 4);

  return (
    <div
      onDragOver={dragHandlers.onDragOver}
      onDrop={dragHandlers.onDrop}
      className={cn(
        "group relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 px-3 py-3 transition-colors duration-150 ease-out hover:bg-hover sm:px-4 md:grid-cols-[auto_minmax(180px,1.1fr)_120px_minmax(0,2fr)_88px_auto] md:gap-x-4",
        dragging && "opacity-40",
        dragOver && "shadow-[inset_0_2px_0_var(--color-accent)]",
      )}
    >
      {flashTs > 0 && <span key={flashTs} aria-hidden className="pointer-events-none absolute inset-0 motion-safe:animate-flash" />}

      <button
        type="button"
        draggable
        onDragStart={dragHandlers.onDragStart}
        onDragEnd={dragHandlers.onDragEnd}
        onKeyDown={e => {
          if (e.key === "ArrowUp" && index > 0) {
            e.preventDefault();
            onMove(index, index - 1);
          } else if (e.key === "ArrowDown" && index < count - 1) {
            e.preventDefault();
            onMove(index, index + 1);
          }
        }}
        aria-label={`Priority ${index + 1} of ${count}. Drag or use arrow keys to reorder ${code}`}
        className="relative inline-flex h-8 w-5 cursor-grab touch-none items-center justify-center rounded text-fg-subtle transition-colors duration-150 hover:text-fg active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-accent"
      >
        <GripVertical className="size-4" aria-hidden />
      </button>

      <a
        href={hrefWithMock(href)}
        onClick={linkClick(href)}
        className="relative min-w-0 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-sm font-medium text-fg">{code}</span>
          {course.kind === "any" && (
            <span className="rounded-full border border-border-strong px-1.5 text-[0.6875rem] text-fg-muted">Any</span>
          )}
        </span>
        <span className="block truncate text-[0.8125rem] text-fg-muted">{course.title}</span>
      </a>

      <div className="relative flex items-center justify-end gap-2 md:hidden">
        <ArmSwitch armed={armed} busy={armBusy} code={code} onChange={setArmed} disabled={course.state === "registered"} />
        {rowMenu()}
      </div>

      <CourseState state={display} className="relative col-start-2 md:col-start-auto" />

      <div className="relative col-span-3 flex min-w-0 flex-wrap gap-1.5 md:col-span-1">
        {course.bundles.length === 0 ? (
          <span className="text-[0.8125rem] text-fg-subtle">{course.kind === "any" ? "No matching combinations" : "No bundles"}</span>
        ) : (
          visibleBundles.map((b, i) => <BundleChip key={b.id} bundle={b} rank={i} seatOf={seatOf} flashKeys={flashKeys} />)
        )}
        {course.bundles.length > visibleBundles.length && (
          <span className="inline-flex h-6 items-center text-xs text-fg-muted tabular-nums">
            +{course.bundles.length - visibleBundles.length}
          </span>
        )}
        {error && <InlineError className="w-full">{error}</InlineError>}
      </div>

      <span className="relative hidden text-right text-xs text-fg-subtle tabular-nums md:block">
        {checked ? relative(checked, now) : "Not checked"}
      </span>

      <div className="relative hidden items-center gap-2 md:flex">
        <ArmSwitch armed={armed} busy={armBusy} code={code} onChange={setArmed} disabled={course.state === "registered"} />
        {rowMenu()}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${code}?`}
        description="Its bundles stop being watched. Your Banner schedule is not touched."
        confirmLabel="Remove"
        onConfirm={async () => {
          await api.deleteWanted(course.id);
          local.removeWanted(course.id);
        }}
      />
    </div>
  );

  function rowMenu() {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${code}`}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => navigate(href)}>
            <Pencil aria-hidden />
            Edit bundles
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(index, index - 1)}>
            <ArrowUp aria-hidden />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === count - 1} onSelect={() => onMove(index, index + 1)}>
            <ArrowDown aria-hidden />
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!(course.state === "blocked" || course.bundles.some(b => b.state === "blocked"))}
            onSelect={reset}
          >
            <ListRestart aria-hidden />
            Reset blocked
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setConfirmRemove(true)}>
            <Trash2 aria-hidden />
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
}

function ArmSwitch({
  armed,
  busy,
  code,
  onChange,
  disabled,
}: {
  armed: boolean;
  busy: boolean;
  code: string;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip content={armed ? "Armed" : "Not armed"}>
      <span className="inline-flex">
        <Switch
          checked={armed}
          onCheckedChange={onChange}
          disabled={busy || disabled}
          loading={busy}
          aria-label={`Arm ${code}`}
        />
      </span>
    </Tooltip>
  );
}

function Watchlist({ now }: { now: number }) {
  const wanted = useStore(s => s.wanted);
  const activeTerm = useStore(s => s.settings?.activeTerm ?? null);
  const list = useMemo(() => wanted.filter(w => !activeTerm || w.term === activeTerm), [wanted, activeTerm]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);

  async function move(from: number, to: number) {
    if (to < 0 || to >= list.length || from === to) return;
    const ids = list.map(w => w.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id!);
    // Keep other terms' courses after this term's, in their existing order.
    const others = wanted.filter(w => !ids.includes(w.id)).map(w => w.id);
    const all = [...ids, ...others];
    const previous = wanted.map(w => w.id);
    local.reorder(all);
    if (liveRef.current) liveRef.current.textContent = `${courseCode(list[from]!)} moved to priority ${to + 1}`;
    setError(null);
    requestAnimationFrame(() => {
      const handles = document.querySelectorAll<HTMLButtonElement>("[data-watchlist] button[draggable]");
      handles[to]?.focus();
    });
    try {
      await api.reorder(all);
    } catch (e) {
      local.reorder(previous);
      setError(errorMessage(e));
    }
  }

  if (list.length === 0)
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface px-6 py-14 text-center">
        <h2 className="text-base font-semibold">Nothing watched yet</h2>
        <p className="max-w-sm text-sm text-fg-muted">
          Find a course, pick the sections you want, and arm it. Seats are checked every few seconds.
        </p>
        <Button variant="primary" className="mt-2" onClick={() => navigate("/search")}>
          <Search aria-hidden />
          Search courses
        </Button>
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      <List data-watchlist aria-label="Watchlist">
        {list.map((course, i) => (
          <WatchRow
            key={course.id}
            course={course}
            index={i}
            count={list.length}
            now={now}
            onMove={move}
            dragging={dragIndex === i}
            dragOver={overIndex === i && dragIndex !== null && dragIndex !== i}
            dragHandlers={{
              onDragStart: e => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(course.id));
                setDragIndex(i);
              },
              onDragEnd: () => {
                setDragIndex(null);
                setOverIndex(null);
              },
              onDragOver: e => {
                if (dragIndex === null) return;
                e.preventDefault();
                setOverIndex(i);
              },
              onDrop: e => {
                e.preventDefault();
                if (dragIndex !== null) move(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              },
            }}
          />
        ))}
      </List>
      <p ref={liveRef} aria-live="polite" className="sr-only" />
      <InlineError>{error}</InlineError>
    </div>
  );
}

// ---------- page ----------

function Feed({ now }: { now: number }) {
  const events = useStore(s => s.events);
  const latest = events.slice(0, 30);
  return (
    <section aria-labelledby="feed-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex h-8 items-center justify-between">
        <h2 id="feed-title" className="text-sm font-semibold">
          Activity
        </h2>
        <a
          href={hrefWithMock("/activity")}
          onClick={linkClick("/activity")}
          className="rounded text-[0.8125rem] text-fg-muted transition-colors duration-150 hover:text-fg"
        >
          View all
        </a>
      </div>
      {latest.length === 0 ? (
        <p className="rounded-lg border border-border px-4 py-8 text-center text-[0.8125rem] text-fg-muted">No events yet</p>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-border bg-surface [&>*+*]:border-t [&>*+*]:border-border">
          {latest.map(e => (
            <EventRow key={e.id} event={e} now={now} compact />
          ))}
        </ol>
      )}
    </section>
  );
}

export function OverviewPage() {
  const now = useNow(1000);
  const approvals = useStore(s => s.approvals.filter(a => a.state === "pending"));
  const count = useStore(s => s.wanted.filter(w => !s.settings?.activeTerm || w.term === s.settings.activeTerm).length);

  return (
    <div className="flex flex-col gap-6">
      <GuardBanner />
      <PageHeader title="Overview">
        <Button variant="primary" size="sm" onClick={() => navigate("/search")}>
          <Plus aria-hidden />
          Add course
        </Button>
      </PageHeader>
      <StatusRow now={now} />

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          {approvals.length > 0 && (
            <section aria-labelledby="approvals-title" className="flex flex-col gap-3">
              <h2 id="approvals-title" className="text-sm font-semibold">
                Waiting for you
              </h2>
              <List className="border-[#3d2560]">
                {approvals.map(a => (
                  <ApprovalRow key={a.id} approval={a} now={now} />
                ))}
              </List>
            </section>
          )}
          <section aria-labelledby="watch-title" className="flex flex-col gap-3">
            <div className="flex h-8 items-center gap-2">
              <h2 id="watch-title" className="text-sm font-semibold">
                Watchlist
              </h2>
              {count > 0 && <span className="text-[0.8125rem] text-fg-subtle tabular-nums">{count}</span>}
            </div>
            <Watchlist now={now} />
          </section>
        </div>
        <Feed now={now} />
      </div>
    </div>
  );
}
