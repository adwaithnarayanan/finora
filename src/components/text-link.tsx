import Link from "next/link";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/** An underlined in-text link. */
export function TextLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cn("underline underline-offset-4", className)} {...props} />;
}
