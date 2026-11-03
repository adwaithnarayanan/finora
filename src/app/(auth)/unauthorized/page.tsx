import type { Metadata } from "next";

import { AuthCard } from "@/features/auth/auth-card";
import { TextLink } from "@/components/text-link";

export const metadata: Metadata = { title: "No access" };

export default function UnauthorizedPage() {
  return (
    <AuthCard
      title="No access"
      description="This account is not authorised to use this Finora workspace."
    >
      <p className="text-sm text-muted-foreground">
        If you are the owner, sign in with the owner account.{" "}
        <TextLink href="/login">
          Go to sign in
        </TextLink>
      </p>
    </AuthCard>
  );
}
