import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { TextLink } from "@/components/text-link";
import { ConfirmAction } from "@/components/confirm-action";
import { PageLoading } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatLedgerDate,
  formatMoney,
  todayInIndia,
} from "@/features/shared/format";
import { voidTransactionAction } from "@/features/transactions/actions";
import { TransactionDetailsForm } from "@/features/transactions/details-form";
import { TransactionList } from "@/features/transactions/transaction-list";
import { lookupsFrom, toTransactionView } from "@/features/transactions/view";
import { orNotFound } from "@/features/shared/not-found";
import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

export const metadata: Metadata = { title: "Transaction" };

export default function TransactionPage({
  params,
}: PageProps<"/transactions/[id]">) {
  return (
    <Suspense fallback={<PageLoading label="Loading transaction…" />}>
      <TransactionDetail params={params} />
    </Suspense>
  );
}

async function TransactionDetail({
  params,
}: Pick<PageProps<"/transactions/[id]">, "params">) {
  const owner = await requireOwner();
  const { id } = await params;
  const transaction = await orNotFound(finance.getTransaction(owner, id));
  const [accounts, categories, refunds, refunded] = await Promise.all([
    finance.listAccounts(owner),
    finance.listCategories(owner),
    finance.getPurchaseRefunds(owner, id),
    transaction.kind === "card_refund" && transaction.refundsTransactionId
      ? finance.getTransaction(owner, transaction.refundsTransactionId)
      : null,
  ]);
  const lookups = lookupsFrom(
    accounts.map((a) => a.account),
    categories,
  );
  const view = toTransactionView(transaction, lookups);
  const link = (accountId: string | null) =>
    accountId ? (
      <TextLink href={`/accounts/${accountId}`}>
        {lookups.accounts.get(accountId)?.name ?? "Account"}
      </TextLink>
    ) : null;

  return (
    <div className="grid max-w-2xl gap-8">
      <div>
        <p className="text-sm text-muted-foreground">
          <Link
            href="/transactions"
            className="underline-offset-4 hover:underline"
          >
            Transactions
          </Link>{" "}
          / {view.kindLabel}
        </p>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
          {view.title}
          {view.voided ? (
            <Badge variant="destructive">
              {view.corrected ? "Corrected" : "Void"}
            </Badge>
          ) : null}
        </h1>
        <p
          className={`mt-2 text-3xl font-semibold tabular-nums ${view.voided ? "text-muted-foreground line-through" : ""}`}
        >
          {view.amount}
        </p>
      </div>

      <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Date</dt>
        <dd>{view.dateLabel}</dd>
        {transaction.sourceAccountId ? (
          <>
            <dt className="text-muted-foreground">
              {transaction.kind === "expense" ||
              transaction.kind === "card_payment"
                ? "Paid from"
                : "From"}
            </dt>
            <dd>{link(transaction.sourceAccountId)}</dd>
          </>
        ) : null}
        {transaction.destinationAccountId ? (
          <>
            <dt className="text-muted-foreground">
              {transaction.kind === "opening_balance"
                ? "Account"
                : transaction.kind === "card_payment"
                  ? "Card paid"
                  : transaction.kind === "card_refund"
                    ? "Refunded to"
                    : "To"}
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
        {transaction.kind === "card_refund" ? (
          <>
            <dt className="text-muted-foreground">Refund of</dt>
            <dd>
              {refunded ? (
                <TextLink href={`/transactions/${refunded.id}`}>
                  {toTransactionView(refunded, lookups).title} of{" "}
                  {formatMoney(refunded.amount)} on{" "}
                  {formatLedgerDate(refunded.occurredOn)}
                </TextLink>
              ) : (
                "A purchase that is not recorded in Finora (a merchant credit)"
              )}
              . It reduces the amount owed on the card and this category&apos;s
              expenses; it is not income.
            </dd>
          </>
        ) : null}
        {transaction.voidedAt ? (
          <>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {view.corrected ? "Corrected" : "Voided"} on{" "}
              {formatLedgerDate(
                transaction.voidedAt.toISOString().slice(0, 10),
              )}
              . A reversing entry cancels its effect; the original stays on
              record.
              {transaction.replacedByTransactionId ? (
                <>
                  {" "}
                  <TextLink
                    href={`/transactions/${transaction.replacedByTransactionId}`}
                  >
                    See the replacement
                  </TextLink>
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
          <CardDescription>
            Payee and note can be edited. Amount, date, accounts and category
            are fixed once recorded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionDetailsForm
            transactionId={transaction.id}
            payee={transaction.payee}
            note={transaction.note}
            allowPayee={
              transaction.kind === "income" ||
              transaction.kind === "expense" ||
              transaction.kind === "card_refund"
            }
          />
        </CardContent>
      </Card>

      {refunds ? (
        <Card>
          <CardHeader>
            <CardTitle>Refunds</CardTitle>
            <CardDescription>
              A refund of this purchase credits the same expense category, so it
              reduces your expenses and the amount owed on the card. It is never
              recorded as income.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-sm">
              <span className="font-medium tabular-nums">
                {formatMoney(refunds.refunded)}
              </span>{" "}
              refunded of{" "}
              <span className="tabular-nums">
                {formatMoney(refunds.purchase.amount)}
              </span>
              , leaving{" "}
              <span className="font-medium tabular-nums">
                {formatMoney(refunds.remaining)}
              </span>{" "}
              refundable.
            </p>
            {refunds.refunds.length > 0 ? (
              <TransactionList
                transactions={refunds.refunds.map((r) =>
                  toTransactionView(r, lookups),
                )}
                empty=""
              />
            ) : null}
            {!transaction.voidedAt && !refunds.remaining.isZero() ? (
              <div>
                <Link
                  href={`/transactions/new?type=card_refund&purchase=${transaction.id}`}
                  className={buttonVariants({ size: "sm", variant: "outline" })}
                >
                  Record a refund
                </Link>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {!transaction.voidedAt && transaction.kind !== "opening_balance" ? (
        <Card>
          <CardHeader>
            <CardTitle>Void</CardTitle>
            <CardDescription>
              Made a mistake? Voiding records a reversing entry that cancels
              this transaction. Then record it again correctly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {refunds && !refunds.refunded.isZero() ? (
              <p className="text-sm text-muted-foreground">
                This purchase has refunds recorded against it. Void those first,
                so no refund is left refunding nothing.
              </p>
            ) : (
              <ConfirmAction
                action={voidTransactionAction}
                fields={{
                  transactionId: transaction.id,
                  idempotencyKey: randomUUID(),
                  date: todayInIndia(),
                }}
                label="Void transaction"
                confirmLabel="Yes, void it"
                description={`Void this ${view.kindLabel.toLowerCase()} of ${view.amount}? Balances return to what they were without it.`}
              />
            )}
          </CardContent>
        </Card>
      ) : null}
      {transaction.kind === "opening_balance" &&
      !transaction.voidedAt &&
      transaction.destinationAccountId ? (
        <p className="text-sm text-muted-foreground">
          Opening balances are corrected from the{" "}
          <TextLink href={`/accounts/${transaction.destinationAccountId}`}>
            account page
          </TextLink>
          .
        </p>
      ) : null}
    </div>
  );
}
