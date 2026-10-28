import * as React from "react";
import { cn } from "@/lib/utils";

export const inputClass =
  "h-9 w-full min-w-0 rounded-md border border-border-strong bg-surface-2 px-3 text-sm text-fg placeholder:text-placeholder transition-[border-color,box-shadow] duration-150 ease-out hover:border-border-hover focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-error aria-[invalid=true]:ring-error/30";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(inputClass, className)} {...props} />;
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-[0.8125rem] font-medium text-fg", className)} {...props} />;
}

export function FieldError({ children, id }: { children?: React.ReactNode; id?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-[0.8125rem] text-error-fg">
      {children}
    </p>
  );
}

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-black px-1 font-sans text-[0.6875rem] font-medium text-fg-muted",
        className,
      )}
      {...props}
    />
  );
}
