import type { AppEvent, Bundle, SeatInfo, Severity } from "../../src/core/types";
import { Dot, Status, type Tone } from "@/components/ui/status-dot";
import { Tooltip } from "@/components/ui/tooltip";
import { relative, type CourseDisplayState } from "@/lib/format";
import { cn } from "@/lib/utils";

export function seatTone(seat: SeatInfo | undefined): Tone {
  if (!seat) return "off";
  return seat.available > 0 ? "ready" : "error";
}

/** "12 / 400" with a dot. Text carries the meaning, the dot reinforces. */
export function SeatCount({ seat, className }: { seat: SeatInfo | undefined | null; className?: string }) {
  if (!seat)
    return (
      <span className={cn("inline-flex items-center gap-2 text-fg-subtle", className)}>
        <Dot tone="off" />
        <span className="font-mono text-[0.8125rem]">Unknown</span>
      </span>
    );
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <Dot tone={seatTone(seat)} />
      <span className="font-mono text-[0.8125rem] tabular-nums">
        <span className={seat.available > 0 ? "text-fg" : "text-fg-muted"}>{seat.available}</span>
        <span className="text-fg-subtle"> / {seat.max}</span>
      </span>
      <span className="sr-only">{seat.available > 0 ? "seats open" : "full"}</span>
    </span>
  );
}

const bundleStateLabel: Record<Bundle["state"], string> = {
  watching: "Watching",
  open: "Open",
  pending_approval: "Awaiting approval",
  registering: "Registering",
  blocked: "Blocked",
  registered: "Registered",
};

/** One ranked bundle: CRNs in mono joined by "+", each with its live seats. */
export function BundleChip({
  bundle,
  seatOf,
  rank,
  flashKeys,
}: {
  bundle: Bundle;
  seatOf: (crn: string) => SeatInfo | undefined;
  rank: number;
  flashKeys?: Set<string>;
}) {
  const highlighted = bundle.state === "open" || bundle.state === "pending_approval" || bundle.state === "registering";
  const blocked = bundle.state === "blocked";
  const label = `Choice ${rank + 1}: ${bundle.crns.join(" plus ")}. ${bundleStateLabel[bundle.state]}${
    bundle.blockedReason ? `. ${bundle.blockedReason}` : ""
  }`;
  const chip = (
    <span
      aria-label={label}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border border-border-strong bg-black pl-1 pr-2.5 font-mono text-xs tabular-nums",
        highlighted && "border-[#3d2560]",
        bundle.state === "registered" && "border-[#1d4d43]",
        blocked && "border-dashed text-fg-subtle line-through decoration-fg-subtle",
      )}
    >
      <span
        aria-hidden
        className="inline-flex size-4 items-center justify-center rounded-full bg-selected text-[0.625rem] text-fg-muted no-underline"
      >
        {rank + 1}
      </span>
      {bundle.crns.map((crn, i) => {
        const seat = seatOf(crn);
        return (
          <span key={crn} className="inline-flex items-center gap-1" aria-hidden>
            {i > 0 && <span className="text-fg-subtle">+</span>}
            <span className={cn(flashKeys?.has(crn) && "motion-safe:animate-flash rounded-sm")}>{crn}</span>
            <Dot tone={blocked ? "off" : seatTone(seat)} className="size-1.5 [&>span]:size-1.5" />
            {seat && <span className={seat.available > 0 ? "text-ready" : "text-fg-subtle"}>{seat.available}</span>}
          </span>
        );
      })}
    </span>
  );
  if (bundle.blockedReason) return <Tooltip content={bundle.blockedReason}>{chip}</Tooltip>;
  return chip;
}

export const courseStateMeta: Record<CourseDisplayState, { tone: Tone; label: string; pulse?: boolean }> = {
  watching: { tone: "accent", label: "Watching" },
  open: { tone: "ready", label: "Open", pulse: true },
  pending: { tone: "violet", label: "Awaiting approval", pulse: true },
  registering: { tone: "ready", label: "Registering", pulse: true },
  registered: { tone: "ready", label: "Registered" },
  blocked: { tone: "error", label: "Blocked" },
  unarmed: { tone: "off", label: "Not armed" },
};

export function CourseState({ state, className }: { state: CourseDisplayState; className?: string }) {
  const meta = courseStateMeta[state];
  return (
    <Status tone={meta.tone} pulse={meta.pulse} className={cn("text-[0.8125rem]", className)}>
      {meta.label}
    </Status>
  );
}

export const severityTone: Record<Severity, Tone> = {
  info: "neutral",
  success: "ready",
  warning: "warning",
  critical: "error",
};

export const severityLabel: Record<Severity, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  critical: "Critical",
};

export function EventRow({ event, now, compact }: { event: AppEvent; now: number; compact?: boolean }) {
  return (
    <li className={cn("flex gap-3 px-4", compact ? "py-2.5" : "py-3")}>
      <span className="flex h-[1.2rem] shrink-0 items-center">
        <Dot tone={severityTone[event.severity]} />
      </span>
      <span className="sr-only">{severityLabel[event.severity]}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="min-w-0 flex-1 truncate text-[0.8125rem] text-fg" title={event.title}>
            {event.title}
          </p>
          <time
            dateTime={new Date(event.ts).toISOString()}
            title={new Date(event.ts).toLocaleString()}
            className="shrink-0 text-xs text-fg-subtle tabular-nums"
          >
            {relative(event.ts, now)}
          </time>
        </div>
        {event.detail && <p className={cn("mt-0.5 text-xs text-fg-muted", compact && "truncate")}>{event.detail}</p>}
        {!compact && event.crns.length > 0 && (
          <p className="mt-1 font-mono text-xs text-fg-subtle tabular-nums">{event.crns.join(" + ")}</p>
        )}
      </div>
    </li>
  );
}
