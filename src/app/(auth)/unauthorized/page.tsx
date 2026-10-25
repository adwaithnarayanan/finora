import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/features/auth/auth-card";

export const metadata: Metadata = { title: "No access" };

export default function UnauthorizedPage() {
  return (
    <AuthCard
      title="No access"
      description="This account is not authorised to use this Finora workspace."
    >
      <p className="text-sm text-muted-foreground">
        If you are the owner, sign in with the owner account.{" "}
        <Link href="/login" className="underline underline-offset-4">
          Go to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
