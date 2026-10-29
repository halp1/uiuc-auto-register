import { CircleCheck, CircleX } from "lucide-react";
import type { RehearsalReport } from "../../src/core/contracts";
import { InlineError } from "@/components/ui/list";
import { formatDateTime, termName } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function stepLabel(name: string): string {
  if (name === "login") return "Log in";
  if (name === "term_open") return "Term open for registration";
  if (name === "read_schedule") return "Read your schedule";
  if (name === "no_writes") return "Nothing submitted";
  if (name === "time_ticket") return "Time ticket";
  const crn = /^crn_(\d+)$/.exec(name);
  if (crn) return `CRN ${crn[1]} exists`;
  return name;
}

/** The result of a test run (internally "rehearsal"). Shared by Settings and setup. */
export function TestReportView({ report, onlyFailed = false }: { report: RehearsalReport; onlyFailed?: boolean }) {
  const terms = useStore(s => s.terms);
  const readerTerm = report.readerTerm ?? report.term;
  const readerName = termName(terms, readerTerm);
  const opensAt = report.opensAt ?? null;
  const classes = report.schedule?.length ?? 0;
  const steps = onlyFailed ? report.steps.filter(s => !s.ok) : report.steps;

  return (
    <div className="flex flex-col gap-3">
      {opensAt && (
        <p role="status" className="rounded-md border border-border bg-black px-3 py-2.5 text-[0.8125rem] text-fg">
          Registration opens <span className="tabular-nums">{formatDateTime(opensAt)}</span>.
          {report.schedule && readerTerm !== report.term && (
            <span className="text-fg-muted">
              {" "}
              Your schedule reader was checked on {readerName} ({classes} {classes === 1 ? "class" : "classes"}).
            </span>
          )}
        </p>
      )}
      {steps.length > 0 && (
        <ol className="overflow-hidden rounded-md border border-border [&>*+*]:border-t [&>*+*]:border-border">
          {steps.map((step, i) => (
            <li key={i} className="flex items-center gap-3 bg-black px-3 py-2.5 text-[0.8125rem]">
              {step.ok ? (
                <CircleCheck className="size-4 shrink-0 text-ready" aria-label="Passed" />
              ) : (
                <CircleX className="size-4 shrink-0 text-error-fg" aria-label="Failed" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block">{stepLabel(step.name)}</span>
                {step.detail && <span className={cn("block text-xs", step.ok ? "text-fg-muted" : "text-error-fg")}>{step.detail}</span>}
              </span>
              <span className="font-mono text-xs text-fg-subtle tabular-nums">{(step.ms / 1000).toFixed(1)}s</span>
            </li>
          ))}
        </ol>
      )}
      {!onlyFailed && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[0.8125rem]">
          {report.eligibility && (
            <>
              <dt className="text-fg-muted">Eligibility</dt>
              <dd>{report.eligibility.allowed ? "Allowed" : report.eligibility.messages.join(" ") || "Not allowed"}</dd>
            </>
          )}
          {report.schedule && (
            <>
              <dt className="text-fg-muted">{readerName} classes</dt>
              <dd className="font-mono tabular-nums">{report.schedule.join(", ") || "None"}</dd>
            </>
          )}
          <dt className="text-fg-muted">Writes blocked</dt>
          <dd className={cn("font-mono tabular-nums", report.blockedWrites > 0 && "text-warning")}>{report.blockedWrites}</dd>
        </dl>
      )}
      {report.crnChecks.some(c => !c.exists) && (
        <InlineError>
          Missing CRNs: {report.crnChecks.filter(c => !c.exists).map(c => c.crn).join(", ")}
        </InlineError>
      )}
    </div>
  );
}
