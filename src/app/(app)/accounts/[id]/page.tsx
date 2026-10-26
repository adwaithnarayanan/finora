import { randomUUID } from "node:crypto";

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ConfirmAction } from "@/components/confirm-action";
import { PageLoading } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EditAccountForm, OpeningBalanceForm } from "@/features/accounts/account-forms";
import { archiveAccountAction, deleteAccountAction, restoreAccountAction } from "@/features/accounts/actions";
import { formatAccountBalance, toAccountView } from "@/features/accounts/view";
import { formatLedgerDate, formatMoney, todayInIndia } from "@/features/shared/format";
import { TransactionList } from "@/features/transactions/transaction-list";
import { lookupsFrom, toTransactionView } from "@/features/transactions/view";
import { requireOwner } from "@/server/auth/session";
import { FinanceNotFoundError, finance } from "@/server/finance";

export const metadata: Metadata = { title: "Account" };

export default function AccountPage({ params }: PageProps<"/accounts/[id]">) {
  return (
    <Suspense fallback={<PageLoading label="Loading account…" />}>
      <AccountDetail params={params} />
    </Suspense>
  );
}

async function AccountDetail({ params }: Pick<PageProps<"/accounts/[id]">, "params">) {
  const owner = await requireOwner();
  const { id } = await params;
  const detail = await finance.getAccount(owner, id).catch((error: unknown) => {
    if (error instanceof FinanceNotFoundError) notFound();
    throw error;
  });
  const [accounts, categories, recent] = await Promise.all([
    finance.listAccounts(owner),
    finance.listCategories(owner),
    finance.listTransactions(owner, { accountId: detail.account.id, limit: 10 }),
  ]);
  const view = toAccountView(detail);
  const lookups = lookupsFrom(
    accounts.map((a) => a.account),
    categories,
  );
  const opening = detail.openingBalance;
  const today = todayInIndia();
  const card = view.ledgerKind === "liability";

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            <Link href="/accounts" className="underline-offset-4 hover:underline">
              Accounts
            </Link>{" "}
            / {view.typeLabel} · {view.currencyCode}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            {view.name}
            {view.archived ? <Badge variant="secondary">Archived</Badge> : null}
          </h1>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">{card ? "Posted balance (owed on the card)" : "Posted balance"}</p>
          <p className={`text-3xl font-semibold tabular-nums ${view.negative ? "text-destructive" : ""}`}>{view.balance}</p>
        </div>
      </div>

      {view.archived ? (
        <p role="status" className="rounded-lg border bg-muted/40 p-3 text-sm">
          This account is archived. Its history and balance are kept, but it cannot take new transactions until restored.
        </p>
      ) : (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-2">
            <Link href={`/transactions/new?type=expense&account=${view.id}`} className={buttonVariants({ size: "sm" })}>
              {card ? "Record card expense" : "Record transaction"}
            </Link>
          </div>
          {card ? (
            <p className="text-sm text-muted-foreground">
              Expenses paid with this card add to the amount owed. Card payments and refunds cannot be recorded yet.
            </p>
          ) : null}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Opening balance</CardTitle>
          <CardDescription>
            {card
              ? "What you owed on the card when you began tracking it. It is not an expense for any period."
              : "The starting position when you began tracking this account. It is not income for any period."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {opening ? (
            <>
              <p className="text-sm">
                <span className="font-medium tabular-nums">
                  {card ? formatAccountBalance("liability", opening.amount) : formatMoney(opening.amount)}
                </span>{" "}
                as of{" "}
                {formatLedgerDate(opening.occurredOn)}
              </p>
              {!view.archived ? (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Correct the opening balance</summary>
                  <div className="mt-3">
                    <OpeningBalanceForm
                      accountId={view.id}
                      idempotencyKey={randomUUID()}
                      today={opening.occurredOn}
                      mode="correct"
                      currencyCode={view.currencyCode}
                      owed={card}
                    />
                  </div>
                </details>
              ) : null}
            </>
          ) : view.archived ? (
            <p className="text-sm text-muted-foreground">No opening balance.</p>
          ) : (
            <OpeningBalanceForm
              accountId={view.id}
              idempotencyKey={randomUUID()}
              today={today}
              mode="set"
              currencyCode={view.currencyCode}
              owed={card}
            />
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="recent" className="grid gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="recent" className="text-lg font-semibold">
            Recent activity
          </h2>
          <Link href={`/transactions?account=${view.id}`} className="text-sm underline underline-offset-4">
            All transactions
          </Link>
        </div>
        <TransactionList
          transactions={recent.map((t) => toTransactionView(t, lookups, view.id))}
          empty="No transactions yet."
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Account settings</CardTitle>
          <CardDescription>The currency cannot be changed once the account exists.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <EditAccountForm account={{ id: view.id, name: view.name, type: view.type, typeLabel: view.typeLabel }} />
          <div className="grid gap-3 border-t pt-4">
            <div className="flex flex-wrap gap-2">
              {view.archived ? (
                <ConfirmAction
                  action={restoreAccountAction}
                  fields={{ accountId: view.id }}
                  label="Restore account"
                  confirmLabel="Yes, restore"
                  description={`Restore ${view.name}? It will accept new transactions again.`}
                  variant="default"
                />
              ) : (
                <ConfirmAction
                  action={archiveAccountAction}
                  fields={{ accountId: view.id }}
                  label="Archive account"
                  confirmLabel="Yes, archive"
                  description={`Archive ${view.name}? Its history and balance are kept; it stops accepting new transactions. You can restore it later.`}
                />
              )}
              {view.canDelete ? (
                <ConfirmAction
                  action={deleteAccountAction}
                  fields={{ accountId: view.id }}
                  label="Delete account"
                  confirmLabel="Yes, delete permanently"
                  description={`Permanently delete ${view.name}? It has no history, so nothing else is affected. This cannot be undone.`}
                />
              ) : null}
            </div>
            {!view.canDelete ? (
              <p className="text-xs text-muted-foreground">
                Accounts with history cannot be deleted, so past records stay complete. Archive it instead.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
