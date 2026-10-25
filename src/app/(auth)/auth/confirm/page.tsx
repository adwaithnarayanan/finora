import type { Metadata } from "next";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { confirmEmailLink } from "@/features/auth/actions";
import { AuthCard } from "@/features/auth/auth-card";

export const metadata: Metadata = { title: "Confirm" };

/**
 * Landing page for emailed links. It only renders a button: the token is
 * verified by a POST, so mail scanners that prefetch links cannot spend it.
 */
export default function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  return (
    <AuthCard title="Continue to Finora" description="Confirm to verify this link and choose your password.">
      <Suspense fallback={null}>
        <ConfirmForm searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function ConfirmForm({ searchParams }: Pick<PageProps<"/auth/confirm">, "searchParams">) {
  const params = await searchParams;
  const tokenHash = typeof params.token_hash === "string" ? params.token_hash : "";
  const type = typeof params.type === "string" ? params.type : "";
  const next = typeof params.next === "string" ? params.next : "";
  return (
    <form action={confirmEmailLink} className="grid gap-4">
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Button type="submit" className="w-full">
        Continue
      </Button>
    </form>
  );
}
