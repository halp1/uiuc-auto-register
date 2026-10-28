import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow,opacity] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-fg text-black hover:bg-[#cccccc] active:bg-[#b5b5b5] disabled:bg-[#1f1f1f] disabled:text-[#8f8f8f] disabled:opacity-100",
        secondary:
          "border border-border-strong bg-black text-fg hover:border-border-hover hover:bg-surface-2 active:bg-selected",
        ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-selected",
        destructive:
          "border border-border-strong bg-black text-error-fg hover:border-[#5c1f1f] hover:bg-[#1a0808] active:bg-[#240a0a]",
        danger: "bg-error text-white hover:bg-[#cc0000] active:bg-[#b30000]",
        accent: "bg-accent text-white hover:bg-accent-hover active:bg-[#0559c0]",
      },
      size: {
        default: "h-9 px-3 text-sm [&_svg]:size-4",
        sm: "h-8 px-2.5 text-[0.8125rem] [&_svg]:size-3.5",
        xs: "h-7 px-2 text-xs [&_svg]:size-3.5",
        icon: "size-9 [&_svg]:size-4",
        "icon-sm": "size-8 [&_svg]:size-4",
        "icon-xs": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export function Button({ className, variant, size, asChild, loading, disabled, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading && <LoaderCircle className="animate-spin" aria-hidden />}
          {children}
        </>
      )}
    </Comp>
  );
}
