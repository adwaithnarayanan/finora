"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

function Submit({ children, variant }: { children: React.ReactNode; variant: "destructive" | "default" }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" disabled={pending}>
      {pending ? "Working…" : children}
    </Button>
  );
}

/**
 * A destructive or significant action that needs a second, explicit click.
 * The first button reveals what will happen and a confirm/cancel pair; focus
 * moves to the explanation so screen readers announce it.
 */
export function ConfirmAction({
  action,
  fields,
  label,
  confirmLabel,
  description,
  variant = "destructive",
}: {
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  label: string;
  confirmLabel: string;
  description: string;
  variant?: "destructive" | "default";
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form action={action} className="grid gap-2 rounded-lg border p-3" aria-label={label}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p role="status" tabIndex={-1} ref={(node) => node?.focus()} className="text-sm outline-none">
        {description}
      </p>
      <div className="flex flex-wrap gap-2">
        <Submit variant={variant}>{confirmLabel}</Submit>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
