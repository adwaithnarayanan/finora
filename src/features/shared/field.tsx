import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";

export function Field({
  name,
  label,
  hint,
  error,
  children,
}: {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: (props: {
    id: string;
    name: string;
    "aria-invalid"?: true;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const described = [
    hint ? `${name}-hint` : null,
    error ? `${name}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      {children({
        id: name,
        name,
        ...(error ? { "aria-invalid": true as const } : {}),
        ...(described ? { "aria-describedby": described } : {}),
      })}
      {hint ? (
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${name}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({
  state,
}: {
  state: { error?: string; message?: string };
}) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {state.message}
      </p>
    );
  }
  return null;
}
