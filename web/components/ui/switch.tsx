import { Switch as SwitchPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export function Switch({
  className,
  loading,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & { loading?: boolean }) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      aria-busy={loading || undefined}
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border-strong bg-[#1f1f1f] transition-colors duration-150 ease-out hover:border-border-hover data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        loading && "opacity-70",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4 translate-x-px rounded-full bg-fg-muted shadow-[0_1px_2px_rgb(0_0_0/0.5)] transition-[transform,background-color] duration-150 ease-out data-[state=checked]:translate-x-[17px] data-[state=checked]:bg-white",
          loading && "motion-safe:animate-pulse",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
