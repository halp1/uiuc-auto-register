import { Check, ChevronDown } from "lucide-react";
import { Select as S } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
  mono,
}: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: { value: string; label: React.ReactNode }[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  mono?: boolean;
}) {
  return (
    <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border-strong bg-surface-2 px-3 text-left text-sm text-fg transition-[border-color] duration-150 ease-out hover:border-border-hover focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-placeholder",
          mono && "font-mono text-[0.8125rem]",
          className,
        )}
      >
        <span className="truncate">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon asChild>
          <ChevronDown className="size-4 shrink-0 text-fg-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={6}
          className="z-50 max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border-strong bg-[#0a0a0a] shadow-[0_12px_32px_rgb(0_0_0/0.7)] data-[state=open]:animate-in data-[state=open]:fade-in-0 duration-150"
        >
          <S.Viewport className="p-1">
            {options.map(o => (
              <S.Item
                key={o.value}
                value={o.value}
                className={cn(
                  "relative flex h-9 cursor-default select-none items-center rounded-md pl-2 pr-8 text-sm outline-none data-[highlighted]:bg-selected data-[disabled]:opacity-40",
                  mono && "font-mono text-[0.8125rem]",
                )}
              >
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="absolute right-2 inline-flex">
                  <Check className="size-4" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
