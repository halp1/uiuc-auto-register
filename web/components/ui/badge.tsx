import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-medium [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        outline: "border border-border-strong bg-black text-fg",
        muted: "border border-border-strong bg-black text-fg-muted",
        accent: "bg-accent text-white",
        warning: "border border-[#5c3d0a] bg-[#1f1503] text-warning",
        error: "border border-[#5c1f1f] bg-[#1a0808] text-error-fg",
        violet: "border border-[#3d2560] bg-[#160d22] text-violet-fg",
        ready: "border border-[#1d4d43] bg-[#06150f] text-ready",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}
