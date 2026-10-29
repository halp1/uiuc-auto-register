import { Eye, FlaskConical, Zap } from "lucide-react";
import type { SystemStatus } from "../../src/core/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The top bar mode pill. Filled accent only when real registration is on. */
export function ModePill({ status, className }: { status: SystemStatus; className?: string }) {
  if (status.mode === "live" && status.liveEnabled)
    return (
      <Badge variant="accent" className={className}>
        <Zap aria-hidden />
        <span className="label">Live</span>
      </Badge>
    );
  if (status.mode === "live")
    return (
      <Badge variant="warning" className={className} title="Seats that open are only dry runs until Live is on">
        <Zap aria-hidden />
        <span className="label">Live off</span>
      </Badge>
    );
  if (status.mode === "rehearsal")
    return (
      <Badge variant="outline" className={className}>
        <Eye aria-hidden />
        <span className="label">Test</span>
      </Badge>
    );
  return (
    <Badge variant="outline" className={className}>
      <FlaskConical aria-hidden />
      <span className="label">Simulated</span>
    </Badge>
  );
}

/** Small plan-style pill beside the app name. */
export function ModeTag({ status, className }: { status: SystemStatus | null; className?: string }) {
  const label = !status ? "" : status.mode === "live" ? "Live" : status.mode === "rehearsal" ? "Test" : "Simulated";
  if (!status) return null;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[0.6875rem] font-medium",
        status.mode === "live" && status.liveEnabled
          ? "border-accent bg-accent text-white"
          : "border-border-strong text-fg-muted",
        className,
      )}
    >
      {label}
    </span>
  );
}

export function AppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={cn("size-5 shrink-0", className)}>
      <rect width="20" height="20" rx="5" fill="#ededed" />
      <path d="M6 11.5l4-4 4 4" stroke="#000" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 14.5h8" stroke="#000" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
