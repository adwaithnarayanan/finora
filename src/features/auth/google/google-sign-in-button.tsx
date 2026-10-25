"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

import { signInWithGoogle } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Redirecting to Google…" : "Continue with Google"}
    </Button>
  );
}

/** DEFERRED (ADR 0003): the Google sign-in control. Not rendered in email/password mode. */
export function GoogleSignInButton({ next }: { next?: string }) {
  return (
    <form action={signInWithGoogle} className="grid gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <SubmitButton />
    </form>
  );
}
