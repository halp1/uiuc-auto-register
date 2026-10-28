import { ToggleGroup } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: React.ReactNode }[];
  disabled?: boolean;
  "aria-label": string;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={v => v && onChange(v as T)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn("inline-flex h-9 items-center gap-0.5 rounded-md border border-border-strong bg-black p-0.5", className)}
    >
      {options.map(o => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="inline-flex h-full items-center rounded-[4px] px-3 text-[0.8125rem] font-medium text-fg-muted transition-colors duration-150 ease-out hover:text-fg data-[state=on]:bg-selected data-[state=on]:text-fg disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
