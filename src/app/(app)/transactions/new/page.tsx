import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Callout } from "@/components/callout";
import { TextLink } from "@/components/text-link";
import { PageHeader, PageLoading } from "@/components/page-header";
import { buttonVariants } from "@/components/ui/button";
import { toAccountOptions } from "@/features/accounts/view";
import { DefaultCategoriesButton } from "@/features/categories/default-categories-button";
import { todayInIndia } from "@/features/shared/format";
import { TransactionForm } from "@/features/transactions/transaction-form";
import { lookupsFrom, toRefundablePurchaseOptions } from "@/features/transactions/view";
import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

export const metadata: Metadata = { title: "Record transaction" };

export default function NewTransactionPage({ searchParams }: PageProps<"/transactions/new">) {
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Record transaction"
        description="Income, an expense (from an account or on a credit card), a transfer between your accounts, a payment towards a credit card, or a refund onto one."
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
  // The refundable purchases are always loaded: the form lets the owner switch
  // to a refund without reloading the page.
  const [accounts, categories, refundable] = await Promise.all([
    finance.listAccounts(owner),
    finance.listCategories(owner),
    finance.listRefundablePurchases(owner),
  ]);
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
    params.type === "income" ||
    params.type === "transfer" ||
    params.type === "expense" ||
    params.type === "card_payment" ||
    params.type === "card_refund"
      ? params.type
      : usable("expense")
        ? "expense"
        : usable("income")
          ? "income"
          : "transfer";
  // ?account= (from an account's page) preselects that account on the side the
  // form can use it: the paying account for an expense (any) or a transfer
  // (bank or cash), and the card being paid or credited for a card payment or
  // a card refund.
  const named = options.find((o) => o.id === params.account);
  const preselectedSource = named && (type === "expense" || (type === "transfer" && !named.card)) ? named : undefined;
  const preselectedCard = named && (type === "card_payment" || type === "card_refund") && named.card ? named : undefined;
  // ?purchase= (from a card purchase's page) preselects that purchase and the
  // card that paid for it. Only purchases that are still refundable are
  // offered, so a fully refunded or voided one simply does not match.
  const purchases = toRefundablePurchaseOptions(
    refundable,
    lookupsFrom(
      accounts.map((a) => a.account),
      categories,
    ),
  );
  const namedPurchase = type === "card_refund" ? purchases.find((p) => p.id === params.purchase) : undefined;
  const refundCard = namedPurchase?.cardAccountId ?? preselectedCard?.id;
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
            <TextLink href="/categories">
              Categories
            </TextLink>{" "}
            page. You can rename or archive any of them later.
          </p>
          <DefaultCategoriesButton returnTo="/transactions/new" />
        </section>
      ) : missing.length > 0 ? (
        <Callout className="p-4">
          You have no active {missing.join(" or ")} categories, so {missing.length === 2 ? "income and expenses" : missing[0] === "income" ? "income" : "expenses"}{" "}
          can&apos;t be recorded yet. Add or restore one on the{" "}
          <TextLink href="/categories">
            Categories
          </TextLink>{" "}
          page.
        </Callout>
      ) : null}
      <TransactionForm
        // Remount when the starting kind changes (e.g. after adding the
        // default categories), since the form keeps its kind in state.
        key={type}
        idempotencyKey={randomUUID()}
        today={todayInIndia()}
        initialKind={type}
        {...(preselectedSource ? { initialSourceAccountId: preselectedSource.id } : {})}
        {...(refundCard ? { initialDestinationAccountId: refundCard } : {})}
        {...(namedPurchase ? { initialPurchaseId: namedPurchase.id } : {})}
        accounts={options}
        incomeCategories={active.filter((c) => c.kind === "income").map((c) => ({ id: c.id, label: c.name }))}
        expenseCategories={active.filter((c) => c.kind === "expense").map((c) => ({ id: c.id, label: c.name }))}
        purchases={purchases}
      />
    </div>
  );
}
