import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageHeader, PageLoading } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { toAccountOptions } from "@/features/accounts/view";
import { DefaultCategoriesButton } from "@/features/categories/default-categories-button";
import { todayInIndia } from "@/features/shared/format";
import { TransactionForm } from "@/features/transactions/transaction-form";
import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

export const metadata: Metadata = { title: "Record transaction" };

export default function NewTransactionPage({ searchParams }: PageProps<"/transactions/new">) {
  return (
    <div className="max-w-2xl">
      <PageHeader title="Record transaction" description="Income, an expense, or a transfer between your accounts." />
      <Suspense fallback={<PageLoading />}>
        <NewTransaction searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function NewTransaction({ searchParams }: Pick<PageProps<"/transactions/new">, "searchParams">) {
  const owner = await requireOwner();
  const params = await searchParams;
  // Read-only: rendering never creates categories (defaults are added on request).
  const [accounts, categories] = await Promise.all([finance.listAccounts(owner), finance.listCategories(owner)]);
  const options = toAccountOptions(accounts);
  if (options.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="font-medium">You need an account first</p>
        <p className="mt-1 text-sm text-muted-foreground">Transactions move money into, out of, or between your accounts.</p>
        <Link href="/accounts/new" className={buttonVariants({ className: "mt-4" })}>
          Create an account
        </Link>
      </div>
    );
  }
  const active = categories.filter((c) => c.archivedAt === null);
  const type = params.type === "income" || params.type === "transfer" ? params.type : "expense";
  const missing = (["income", "expense"] as const).filter((kind) => !active.some((c) => c.kind === kind));
  return (
    <div className="grid gap-6">
      {missing.length > 0 ? (
        <div role="status" className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <p>
            You have no active {missing.join(" or ")} categories, so only{" "}
            {missing.length === 2 ? "transfers" : `${missing[0] === "income" ? "expenses" : "income"} and transfers`} can be
            recorded.{" "}
            <Link href="/categories" className="underline underline-offset-4">
              Manage categories
            </Link>
            {categories.length === 0 ? " or add the defaults." : "."}
          </p>
          {categories.length === 0 ? (
            <div>
              <DefaultCategoriesButton returnTo="/transactions/new" />
            </div>
          ) : null}
        </div>
      ) : null}
      <TransactionForm
      idempotencyKey={randomUUID()}
      today={todayInIndia()}
      initialKind={type}
      accounts={options}
      incomeCategories={active.filter((c) => c.kind === "income").map((c) => ({ id: c.id, label: c.name }))}
      expenseCategories={active.filter((c) => c.kind === "expense").map((c) => ({ id: c.id, label: c.name }))}
      />
    </div>
  );
}
