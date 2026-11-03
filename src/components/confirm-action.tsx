"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";

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
  const [, submit, pending] = useActionState(
    async (_: null, formData: FormData) => {
      await action(formData);
      return null;
    },
    null,
  );
  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <form
      action={submit}
      className="grid gap-2 rounded-lg border p-3"
      aria-label={label}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <p
        role="status"
        tabIndex={-1}
        ref={(node) => node?.focus()}
        className="text-sm outline-none"
      >
        {description}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant={variant}
          size="sm"
          loading={pending}
          loadingText="Working…"
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
