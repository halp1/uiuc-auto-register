import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { genEdReq, genEdShort } from "../../src/core/gened";
import { sigmaTone } from "../../src/core/grades";
import type { CourseGrades, InstructorGrades } from "../../src/core/types";
import { Segmented } from "@/components/ui/segmented";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const GRADES_SOURCE = "https://waf.cs.illinois.edu/discovery/grade_disparity_between_sections_at_uiuc/";

type Tone = ReturnType<typeof sigmaTone>;

const toneText: Record<Tone, string> = {
  good: "text-[#52a8ff]",
  neutral: "text-fg-muted",
  low: "text-warning",
  bad: "text-error-fg",
};

const toneColor: Record<Tone | "overall", string> = {
  good: "#52a8ff",
  neutral: "#a1a1a1",
  low: "#f5a623",
  bad: "#ff4d4d",
  overall: "#ededed",
};

export const gpaText = (n: number) => n.toFixed(2);

export function signed(n: number) {
  const s = Math.abs(n).toFixed(2);
  return n < 0 && s !== "0.00" ? `-${s}` : `+${s}`;
}

function percents(dist: InstructorGrades["dist"]) {
  const total = dist.reduce((a, b) => a + b, 0);
  return dist.map(n => (total > 0 ? Math.round((n / total) * 100) : 0));
}

function displayName(row: InstructorGrades) {
  return row.key === "" ? "All sections" : row.name;
}

function GradeTip({ row, fallback }: { row: InstructorGrades; fallback?: boolean }) {
  const pct = percents(row.dist);
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">{fallback ? "All sections" : displayName(row)}</p>
      <p className="text-fg-muted tabular-nums">
        {fallback || row.sigma === null ? "Course average" : `${signed(row.sigma)}σ vs course`}
      </p>
      <p className="text-fg-muted tabular-nums">{row.students.toLocaleString()} students</p>
      <p className="flex gap-2 pt-0.5 font-mono tabular-nums">
        {(["A", "B", "C", "D", "F"] as const).map((l, i) => (
          <span key={l}>
            <span className="text-fg-muted">{l}</span> {pct[i]}%
          </span>
        ))}
      </p>
    </div>
  );
}

/** Small GPA pill for an instructor (or the course average when fallback). Null without data. */
export function GpaBadge({
  row,
  fallback,
  className,
}: {
  row: InstructorGrades | null | undefined;
  fallback?: boolean;
  className?: string;
}) {
  if (!row) return null;
  const tone: Tone = fallback ? "neutral" : sigmaTone(row.sigma);
  const sigma = fallback || row.sigma === null ? "course average" : `${signed(row.sigma)} sigma vs course`;
  return (
    <Tooltip content={<GradeTip row={row} fallback={fallback} />}>
      <span
        tabIndex={0}
        aria-label={`GPA ${gpaText(row.avg)}, ${sigma}`}
        className={cn(
          "inline-flex h-5 shrink-0 cursor-default items-center rounded-full border border-border-strong bg-black px-1.5 font-mono text-[0.6875rem] leading-none tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
          toneText[tone],
          className,
        )}
      >
        {gpaText(row.avg)}
      </span>
    </Tooltip>
  );
}

/** Plain course GPA for list rows. Not focusable so it can sit inside a link. */
export function CourseGpa({ gpa, className }: { gpa: number | null; className?: string }) {
  if (gpa === null) return <span className={cn("font-mono text-[0.8125rem] text-fg-subtle", className)} aria-hidden />;
  return (
    <Tooltip content="Average GPA, all sections">
      <span className={cn("font-mono text-[0.8125rem] text-fg-muted tabular-nums", className)}>
        <span className="sr-only">Average GPA </span>
        {gpaText(gpa)}
      </span>
    </Tooltip>
  );
}

/** Compact gen ed pills. Matched codes get an accent border and a check. */
export function GenEdPills({ codes, matched, className }: { codes: string[]; matched?: string[]; className?: string }) {
  if (codes.length === 0) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)}>
      {codes.map(code => {
        const on = matched?.includes(code);
        return (
          <span
            key={code}
            title={genEdReq(code)?.categoryLabel}
            className={cn(
              "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-[0.6875rem] leading-none",
              on ? "border-accent text-fg" : "border-border-strong text-fg-muted",
            )}
          >
            {on && <Check className="size-3 text-[#52a8ff]" aria-label="Matches" />}
            {genEdShort(code)}
          </span>
        );
      })}
    </span>
  );
}

// ---------- grade disparity ----------

const pctOf = (v: number) => `${Math.max(0, Math.min(4, v)) * 25}%`;

function Band({ from, to, color, opacity, h }: { from: number; to: number; color: string; opacity: number; h: number }) {
  const y = (16 - h) / 2;
  return (
    <rect
      x={pctOf(Math.min(from, to))}
      width={`${Math.max(0.5, Math.abs(to - from) * 25)}%`}
      y={y}
      height={h}
      rx={h / 2}
      fill={color}
      fillOpacity={opacity}
    />
  );
}

function BandBar({ row, color }: { row: InstructorGrades; color: string }) {
  const b = row.bands;
  return (
    <svg className="block h-4 w-full overflow-visible" aria-hidden>
      <Band from={b.min} to={b.max} color={color} opacity={0.2} h={8} />
      <Band from={b.p12} to={b.p88} color={color} opacity={0.2} h={10} />
      <Band from={b.p17} to={b.p83} color={color} opacity={0.2} h={12} />
      <Band from={b.p25} to={b.p75} color={color} opacity={0.6} h={14} />
      <rect x={pctOf(row.avg)} width={2} y={0} height={16} fill="#ededed" transform="translate(-1 0)" />
    </svg>
  );
}

// Container queries: the panel sits in the wide course page and in the narrow plan sheet.
const cols =
  "grid grid-cols-[minmax(0,1.1fr)_minmax(80px,1fr)_44px_44px] items-center gap-x-3 @xl:grid-cols-[minmax(0,1fr)_64px_minmax(140px,1.6fr)_52px_44px]";

function DisparityRow({ row, overall, teaching }: { row: InstructorGrades; overall?: boolean; teaching?: boolean }) {
  const tone: Tone = overall ? "neutral" : sigmaTone(row.sigma);
  const color = overall ? toneColor.overall : toneColor[tone];
  return (
    <li className={cn(cols, "min-h-10 px-4 py-1.5 text-[0.8125rem]")}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn("truncate", overall ? "font-semibold" : "text-fg")}>{displayName(row)}</span>
        {teaching && (
          <span className="shrink-0 rounded-full border border-[#10365f] px-1.5 text-[0.6875rem] leading-4 text-[#52a8ff]">This term</span>
        )}
      </span>
      <span className="hidden text-right font-mono text-xs text-fg-muted tabular-nums @xl:block">{row.students.toLocaleString()}</span>
      <span className="relative">
        <BandBar row={row} color={color} />
        <span className="sr-only">
          Middle half {gpaText(row.bands.p25)} to {gpaText(row.bands.p75)}
        </span>
      </span>
      <span className={cn("text-right font-mono text-xs tabular-nums", overall ? "text-fg-subtle" : toneText[tone])}>
        {row.sigma === null || overall ? "" : signed(row.sigma)}
        {!overall && row.sigma !== null && <span className="sr-only"> sigma</span>}
      </span>
      <span className="flex justify-end">
        <GpaBadge row={row} fallback={overall} className={overall ? "text-fg" : undefined} />
      </span>
    </li>
  );
}

const fetchedFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export function GradeDisparity({
  grades,
  teaching,
  className,
}: {
  grades: CourseGrades;
  teaching?: Set<string>;
  className?: string;
}) {
  const current = useMemo(() => grades.instructors.filter(r => teaching?.has(r.key)), [grades, teaching]);
  const others = useMemo(() => grades.instructors.filter(r => !teaching?.has(r.key)), [grades, teaching]);
  const both = current.length > 0 && others.length > 0;
  const [view, setView] = useState<"term" | "all">("term");
  const rows = both && view === "term" ? current : [...current, ...others];

  return (
    <div className={cn("@container overflow-hidden rounded-lg border border-border bg-surface", className)}>
      {both && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <span className="text-xs text-fg-muted tabular-nums">
            {view === "term" ? `${current.length} of ${grades.instructors.length} instructors` : `${grades.instructors.length} instructors`}
          </span>
          <Segmented
            aria-label="Instructors shown"
            value={view}
            onChange={setView}
            className="h-7"
            options={[
              { value: "term", label: "This term" },
              { value: "all", label: "All" },
            ]}
          />
        </div>
      )}
      <div aria-hidden className={cn(cols, "h-8 border-b border-border px-4 text-xs text-fg-muted")}>
        <span>Instructor</span>
        <span className="hidden text-right @xl:block">Students</span>
        <span className="relative h-full">
          {[0, 1, 2, 3, 4].map(t => (
            <span
              key={t}
              className={cn(
                "absolute top-1/2 -translate-y-1/2 font-mono tabular-nums",
                t === 0 ? "translate-x-0" : t === 4 ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${t * 25}%` }}
            >
              {t}
            </span>
          ))}
        </span>
        <span className="text-right">Δσ</span>
        <span className="text-right">GPA</span>
      </div>
      <ul aria-label="Grades by instructor" className="relative [&>li+li]:border-t [&>li+li]:border-border">
        <DisparityRow row={grades.overall} overall />
        {rows.map(r => (
          <DisparityRow key={r.key || r.name} row={r} teaching={teaching?.has(r.key)} />
        ))}
      </ul>
      <p className="border-t border-border bg-black px-4 py-2 text-xs text-fg-subtle">
        <a
          href={GRADES_SOURCE}
          target="_blank"
          rel="noreferrer"
          className="text-fg-muted underline decoration-border-hover underline-offset-2 transition-colors duration-150 hover:text-fg"
        >
          Grade disparity between sections at UIUC
        </a>
        , updated {fetchedFmt.format(grades.fetchedAt)}
      </p>
    </div>
  );
}
