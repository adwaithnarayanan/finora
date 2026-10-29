import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConfirmAction } from "@/components/confirm-action";
import { PageLoading } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLedgerDate, todayInIndia } from "@/features/shared/format";
import { voidTransactionAction } from "@/features/transactions/actions";
import { TransactionDetailsForm } from "@/features/transactions/details-form";
import { lookupsFrom, toTransactionView } from "@/features/transactions/view";
import { requireOwner } from "@/server/auth/session";
import { FinanceNotFoundError, finance } from "@/server/finance";

export const metadata: Metadata = { title: "Transaction" };

export default function TransactionPage({ params }: PageProps<"/transactions/[id]">) {
  return (
    <Suspense fallback={<PageLoading label="Loading transaction…" />}>
      <TransactionDetail params={params} />
    </Suspense>
  );
}

async function TransactionDetail({ params }: Pick<PageProps<"/transactions/[id]">, "params">) {
  const owner = await requireOwner();
  const { id } = await params;
  const transaction = await finance.getTransaction(owner, id).catch((error: unknown) => {
    if (error instanceof FinanceNotFoundError) notFound();
    throw error;
  });
  const [accounts, categories] = await Promise.all([finance.listAccounts(owner), finance.listCategories(owner)]);
  const lookups = lookupsFrom(
    accounts.map((a) => a.account),
    categories,
  );
  const view = toTransactionView(transaction, lookups);
  const link = (accountId: string | null) =>
    accountId ? (
      <Link href={`/accounts/${accountId}`} className="underline underline-offset-4">
        {lookups.accounts.get(accountId)?.name ?? "Account"}
      </Link>
    ) : null;

  return (
    <div className="grid max-w-2xl gap-8">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link href="/transactions" className="underline-offset-4 hover:underline">
            Transactions
          </Link>{" "}
          / {view.kindLabel}
        </p>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {view.title}
          {view.voided ? <Badge variant="destructive">{view.corrected ? "Corrected" : "Void"}</Badge> : null}
        </h1>
        <p className={`mt-2 text-3xl font-semibold tabular-nums ${view.voided ? "text-muted-foreground line-through" : ""}`}>
          {view.amount}
        </p>
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Date</dt>
        <dd>{view.dateLabel}</dd>
        {transaction.sourceAccountId ? (
          <>
            <dt className="text-muted-foreground">{transaction.kind === "expense" || transaction.kind === "card_payment" ? "Paid from" : "From"}</dt>
            <dd>{link(transaction.sourceAccountId)}</dd>
          </>
        ) : null}
        {transaction.destinationAccountId ? (
          <>
            <dt className="text-muted-foreground">
              {transaction.kind === "opening_balance" ? "Account" : transaction.kind === "card_payment" ? "Card paid" : "To"}
            </dt>
            <dd>{link(transaction.destinationAccountId)}</dd>
          </>
        ) : null}
        {transaction.categoryId ? (
          <>
            <dt className="text-muted-foreground">Category</dt>
            <dd>{lookups.categories.get(transaction.categoryId)?.name}</dd>
          </>
        ) : null}
        {transaction.voidedAt ? (
          <>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {view.corrected ? "Corrected" : "Voided"} on{" "}
              {formatLedgerDate(transaction.voidedAt.toISOString().slice(0, 10))}. A reversing entry cancels its effect; the
              original stays on record.
              {transaction.replacedByTransactionId ? (
                <>
                  {" "}
                  <Link href={`/transactions/${transaction.replacedByTransactionId}`} className="underline underline-offset-4">
                    See the replacement
                  </Link>
                  .
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>Payee and note can be edited. Amount, date, accounts and category are fixed once recorded.</CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionDetailsForm
            transactionId={transaction.id}
            payee={transaction.payee}
            note={transaction.note}
            allowPayee={transaction.kind === "income" || transaction.kind === "expense"}
          />
        </CardContent>
      </Card>

      {!transaction.voidedAt && transaction.kind !== "opening_balance" ? (
        <Card>
          <CardHeader>
            <CardTitle>Void</CardTitle>
            <CardDescription>
              Made a mistake? Voiding records a reversing entry that cancels this transaction. Then record it again correctly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConfirmAction
              action={voidTransactionAction}
              fields={{ transactionId: transaction.id, idempotencyKey: randomUUID(), date: todayInIndia() }}
              label="Void transaction"
              confirmLabel="Yes, void it"
              description={`Void this ${view.kindLabel.toLowerCase()} of ${view.amount}? Balances return to what they were without it.`}
            />
          </CardContent>
        </Card>
      ) : null}
      {transaction.kind === "opening_balance" && !transaction.voidedAt && transaction.destinationAccountId ? (
        <p className="text-sm text-muted-foreground">
          Opening balances are corrected from the{" "}
          <Link href={`/accounts/${transaction.destinationAccountId}`} className="underline underline-offset-4">
            account page
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}
