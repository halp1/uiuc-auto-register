import { Check } from "lucide-react";
import { DropdownMenu as DM } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

export const DropdownMenu = DM.Root;
export const DropdownMenuTrigger = DM.Trigger;
export const DropdownMenuGroup = DM.Group;
export const DropdownMenuRadioGroup = DM.RadioGroup;

export const menuContentClass =
  "z-50 min-w-48 overflow-hidden rounded-lg border border-border-strong bg-[#0a0a0a] p-1 text-fg shadow-[0_12px_32px_rgb(0_0_0/0.7)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150";

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  ...props
}: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={sideOffset} align={align} className={cn(menuContentClass, className)} {...props} />
    </DM.Portal>
  );
}

const itemClass =
  "relative flex h-9 cursor-default select-none items-center gap-2 rounded-md px-2 text-sm outline-none transition-colors duration-100 data-[highlighted]:bg-selected data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted";

export function DropdownMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof DM.Item> & { destructive?: boolean }) {
  return (
    <DM.Item
      className={cn(itemClass, destructive && "text-error-fg [&_svg]:text-error-fg", className)}
      {...props}
    />
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof DM.RadioItem>) {
  return (
    <DM.RadioItem className={cn(itemClass, "pr-8", className)} {...props}>
      {children}
      <DM.ItemIndicator className="absolute right-2 inline-flex">
        <Check className="!text-fg" />
      </DM.ItemIndicator>
    </DM.RadioItem>
  );
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn("px-2 py-1.5 text-xs text-fg-muted", className)} {...props} />;
}
