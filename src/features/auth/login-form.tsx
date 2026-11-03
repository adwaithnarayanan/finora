"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/features/shared/field";
import { useFormAction } from "@/features/shared/use-form-action";

import { signIn } from "./actions";

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const { state, action, pending } = useFormAction(signIn, { error: notice });
  return (
    <form action={action} className="grid gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <FormError state={state} />
      <Button type="submit" loading={pending} loadingText="Signing in…" className="w-full">
        Sign in
      </Button>
    </form>
  );
}
