import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** A short status notice, announced politely to screen readers. */
export function Callout({ className, ...props }: ComponentProps<"p">) {
  return <p role="status" className={cn("rounded-lg border bg-muted/40 p-3 text-sm", className)} {...props} />;
}
