"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { signInWithGoogle } from "./actions";

/** DEFERRED (ADR 0003): the Google sign-in control. Not rendered in email/password mode. */
export function GoogleSignInButton({ next }: { next?: string }) {
  const [, submit, pending] = useActionState(async (_: null, formData: FormData) => {
    await signInWithGoogle(formData);
    return null;
  }, null);
  return (
    <form action={submit} className="grid gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Button type="submit" loading={pending} loadingText="Redirecting to Google…" className="w-full">
        Continue with Google
      </Button>
    </form>
  );
}
