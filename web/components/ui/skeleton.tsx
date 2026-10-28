import * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden className={cn("rounded-md bg-[#161616] motion-safe:animate-pulse", className)} {...props} />;
}
