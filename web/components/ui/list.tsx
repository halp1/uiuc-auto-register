import * as React from "react";
import { cn } from "@/lib/utils";

/** Vercel-style bordered list: one rounded container, rows divided by hairlines. */
export function List({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("overflow-hidden rounded-lg border border-border bg-surface [&>*+*]:border-t [&>*+*]:border-border", className)}
      {...props}
    />
  );
}

export function ListRow({ className, interactive, ...props }: React.ComponentProps<"div"> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex min-h-14 items-center gap-4 px-4 py-3 transition-colors duration-150 ease-out",
        interactive && "hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
}

/** Settings card: bordered container with title, body, and a footer bar. */
export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-4 p-5 sm:p-6", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-base font-semibold tracking-[-0.01em]", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-border bg-black px-5 py-3 text-[0.8125rem] text-fg-muted sm:px-6",
        className,
      )}
      {...props}
    />
  );
}

/** Dashed filter chip like Vercel's "Add Filter" row. */
export function FilterChip({
  className,
  active,
  ...props
}: React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border-hover px-2.5 text-xs font-medium text-fg-muted transition-colors duration-150 ease-out hover:border-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5",
        active && "border-solid border-fg-muted bg-selected text-fg",
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  children,
  className,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3", className)}>
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function InlineError({ children, className }: { children?: React.ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn("text-[0.8125rem] text-error-fg", className)}>
      {children}
    </p>
  );
}
