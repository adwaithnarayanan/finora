import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import { Suspense } from "react";

import { PageHeader, PageLoading } from "@/components/page-header";
import { KNOWN_CURRENCIES } from "@/domain/money";
import { CreateAccountForm } from "@/features/accounts/account-forms";
import { todayInIndia } from "@/features/shared/format";
import { requireOwner } from "@/server/auth/session";

export const metadata: Metadata = { title: "New account" };

const CURRENCIES = Object.values(KNOWN_CURRENCIES).map((c) => ({
  code: c.code,
  label: c.code === "INR" ? "INR · Indian rupee" : c.code,
}));

export default function NewAccountPage() {
  return (
    <div className="max-w-2xl">
      <PageHeader title="New account" description="A bank account, cash or a credit card you want to track." />
      <Suspense fallback={<PageLoading />}>
        <NewAccount />
      </Suspense>
    </div>
  );
}

async function NewAccount() {
  await requireOwner();
  // One key per rendered form: a double submit or retry cannot create two accounts.
  return <CreateAccountForm idempotencyKey={randomUUID()} today={todayInIndia()} currencies={CURRENCIES} />;
}
