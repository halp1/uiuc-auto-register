import * as React from "react";
import { cn } from "@/lib/utils";

export type Tone = "ready" | "error" | "warning" | "violet" | "accent" | "neutral" | "off";

const toneClass: Record<Tone, string> = {
  ready: "bg-ready",
  error: "bg-error",
  warning: "bg-warning",
  violet: "bg-violet",
  accent: "bg-accent",
  neutral: "bg-fg-muted",
  off: "bg-[#454545]",
};

export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse && (
        <span
          className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", toneClass[tone])}
        />
      )}
      <span className={cn("relative size-2 rounded-full", toneClass[tone])} />
    </span>
  );
}

/** A dot always paired with a text label, never color alone. */
export function Status({
  tone,
  pulse,
  children,
  className,
  ...props
}: { tone: Tone; pulse?: boolean } & React.ComponentProps<"span">) {
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap", className)} {...props}>
      <Dot tone={tone} pulse={pulse} />
      <span>{children}</span>
    </span>
  );
}
