import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageHeader, PageLoading } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { toAccountView } from "@/features/accounts/view";
import { requireOwner } from "@/server/auth/session";
import { finance } from "@/server/finance";

export const metadata: Metadata = { title: "Accounts" };

export default function AccountsPage({ searchParams }: PageProps<"/accounts">) {
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Bank, cash and credit-card accounts. Balances are calculated from posted entries."
        actions={
          <Link href="/accounts/new" className={buttonVariants()}>
            New account
          </Link>
        }
      />
      <Suspense fallback={<PageLoading label="Loading accounts…" />}>
        <AccountList searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function AccountList({ searchParams }: Pick<PageProps<"/accounts">, "searchParams">) {
  const owner = await requireOwner();
  const showArchived = (await searchParams).archived === "1";
  const accounts = (await finance.listAccounts(owner)).map(toAccountView);
  const archivedCount = accounts.filter((a) => a.archived).length;
  const visible = accounts.filter((a) => showArchived || !a.archived);

  if (accounts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="font-medium">No accounts yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Add a bank, cash or credit-card account, with its opening balance, to start.</p>
        <Link href="/accounts/new" className={buttonVariants({ className: "mt-4" })}>
          Create your first account
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Accounts">
        {visible.map((a) => (
          <li key={a.id}>
            <Link
              href={`/accounts/${a.id}`}
              className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4 outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{a.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.typeLabel} · {a.currencyCode}
                  </span>
                </span>
                {a.archived ? <Badge variant="secondary">Archived</Badge> : null}
              </span>
              <span className={`text-xl font-semibold tabular-nums ${a.negative ? "text-destructive" : ""}`}>
                <span className="sr-only">Balance: </span>
                {a.balance}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {archivedCount > 0 ? (
        <p className="text-sm">
          <Link href={showArchived ? "/accounts" : "/accounts?archived=1"} className="underline underline-offset-4">
            {showArchived ? "Hide archived accounts" : `Show ${archivedCount} archived account${archivedCount === 1 ? "" : "s"}`}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
