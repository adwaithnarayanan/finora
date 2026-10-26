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
      <PageHeader
        title="Record transaction"
        description="Income, an expense (from an account or on a credit card), or a transfer between your accounts."
      />
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
        <p className="mt-1 text-sm text-muted-foreground">
          Transactions move money into, out of, or between your bank and cash accounts, or record spending on a credit
          card.
        </p>
        <Link href="/accounts/new" className={buttonVariants({ className: "mt-4" })}>
          Create an account
        </Link>
      </div>
    );
  }
  const active = categories.filter((c) => c.archivedAt === null);
  const usable = (kind: "income" | "expense") => active.some((c) => c.kind === kind);
  const missing = (["income", "expense"] as const).filter((kind) => !usable(kind));
  // An explicit ?type= wins; otherwise start on a kind that can be recorded.
  const type =
    params.type === "income" || params.type === "transfer" || params.type === "expense"
      ? params.type
      : usable("expense")
        ? "expense"
        : usable("income")
          ? "income"
          : "transfer";
  // ?account= (from an account's page) preselects the paying account when the
  // form can use it: any account for an expense, bank or cash for a transfer.
  const preselected = options.find((o) => o.id === params.account && (type === "expense" || (type === "transfer" && !o.card)));
  return (
    <div className="grid gap-6">
      {categories.length === 0 ? (
        <section aria-labelledby="no-categories" className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <h2 id="no-categories" className="font-medium">
            No categories yet
          </h2>
          <p>
            Income and expenses each need a category; transfers between your accounts don&apos;t. Add the default set
            (Salary, Groceries, Rent and more) to start right away, or create your own on the{" "}
            <Link href="/categories" className="underline underline-offset-4">
              Categories
            </Link>{" "}
            page. You can rename or archive any of them later.
          </p>
          <DefaultCategoriesButton returnTo="/transactions/new" />
        </section>
      ) : missing.length > 0 ? (
        <p role="status" className="rounded-lg border bg-muted/40 p-4 text-sm">
          You have no active {missing.join(" or ")} categories, so {missing.length === 2 ? "income and expenses" : missing[0] === "income" ? "income" : "expenses"}{" "}
          can&apos;t be recorded yet. Add or restore one on the{" "}
          <Link href="/categories" className="underline underline-offset-4">
            Categories
          </Link>{" "}
          page.
        </p>
      ) : null}
      <TransactionForm
        // Remount when the starting kind changes (e.g. after adding the
        // default categories), since the form keeps its kind in state.
        key={type}
        idempotencyKey={randomUUID()}
        today={todayInIndia()}
        initialKind={type}
        {...(preselected ? { initialSourceAccountId: preselected.id } : {})}
        accounts={options}
        incomeCategories={active.filter((c) => c.kind === "income").map((c) => ({ id: c.id, label: c.name }))}
        expenseCategories={active.filter((c) => c.kind === "expense").map((c) => ({ id: c.id, label: c.name }))}
      />
    </div>
  );
}
