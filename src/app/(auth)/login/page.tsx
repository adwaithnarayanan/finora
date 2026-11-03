import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthCard } from "@/features/auth/auth-card";
import { LoginForm } from "@/features/auth/login-form";
import { safeNextPath } from "@/server/auth/redirect";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <AuthCard
      title="Sign in"
      description="Finora is private. Only its owner can sign in."
    >
      <Suspense fallback={null}>
        <LoginFormWithParams searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}

async function LoginFormWithParams({
  searchParams,
}: Pick<PageProps<"/login">, "searchParams">) {
  const params = await searchParams;
  const next =
    typeof params.next === "string" ? safeNextPath(params.next) : undefined;
  return <LoginForm next={next} />;
}
