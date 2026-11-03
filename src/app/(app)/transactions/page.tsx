import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { Callout } from "@/components/callout";
import { TextLink } from "@/components/text-link";
import { PageHeader, PageLoading } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RECORD_KIND_LABELS, type RecordKind } from "@/domain/finance";
import { parseLedgerDate } from "@/domain/ledger";
import { isCanonicalUuid } from "@/domain/shared/uuid";
import { TransactionList } from "@/features/transactions/transaction-list";
import { lookupsFrom, toTransactionView } from "@/features/transactions/view";
import { requireOwner } from "@/server/auth/session";
import { type TransactionFilters, finance } from "@/server/finance";

export const metadata: Metadata = { title: "Transactions" };

type Params = Awaited<PageProps<"/transactions">["searchParams"]>;
const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : "";

function parseFilters(params: Params): {
  filters: Partial<TransactionFilters>;
  raw: Record<string, string>;
} {
  const raw = {
    from: one(params.from),
    to: one(params.to),
    type: one(params.type),
    account: one(params.account),
    category: one(params.category),
    q: one(params.q).slice(0, 100),
    voided: one(params.voided),
  };
  const date = (value: string) => {
    try {
      return value ? parseLedgerDate(value) : undefined;
    } catch {
      return undefined;
    }
  };
  const from = date(raw.from);
  const to = date(raw.to);
  const filters: Partial<TransactionFilters> = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(raw.type in RECORD_KIND_LABELS ? { kind: raw.type as RecordKind } : {}),
    ...(isCanonicalUuid(raw.account) ? { accountId: raw.account } : {}),
    ...(isCanonicalUuid(raw.category) ? { categoryId: raw.category } : {}),
    ...(raw.q.trim() ? { search: raw.q.trim() } : {}),
    includeVoided: raw.voided !== "hide",
  };
  return { filters, raw };
}

export default function TransactionsPage({
  searchParams,
}: PageProps<"/transactions">) {
  return (
    <>
      <PageHeader
        title="Transactions"
        description="Income, expenses, transfers, card payments and opening balances, newest first."
        actions={
          <Link href="/transactions/new" className={buttonVariants()}>
            Record transaction
          </Link>
        }
      />
      <Suspense fallback={<PageLoading label="Loading transactions…" />}>
        <History searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function History({
  searchParams,
}: Pick<PageProps<"/transactions">, "searchParams">) {
  const owner = await requireOwner();
  const params = await searchParams;
  const { filters, raw } = parseFilters(params);
  const [accounts, categories, transactions] = await Promise.all([
    finance.listAccounts(owner),
    finance.listCategories(owner),
    finance.listTransactions(owner, filters),
  ]);
  const lookups = lookupsFrom(
    accounts.map((a) => a.account),
    categories,
  );
  const recorded = isCanonicalUuid(one(params.recorded));
  const filtered =
    Object.keys(filters).some((k) => k !== "includeVoided") ||
    raw.voided === "hide";

  return (
    <div className="grid gap-6">
      {recorded ? <Callout>Transaction recorded.</Callout> : null}
      <form
        method="get"
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-4"
        aria-label="Filter transactions"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="q">Search payee or note</Label>
          <Input id="q" name="q" type="search" defaultValue={raw.q} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="type">Type</Label>
          <NativeSelect id="type" name="type" defaultValue={raw.type}>
            <option value="">All types</option>
            {Object.entries(RECORD_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="account">Account</Label>
          <NativeSelect id="account" name="account" defaultValue={raw.account}>
            <option value="">All accounts</option>
            {accounts.map(({ account }) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {account.archivedAt ? " (archived)" : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="category">Category</Label>
          <NativeSelect
            id="category"
            name="category"
            defaultValue={raw.category}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="from">From</Label>
          <Input id="from" name="from" type="date" defaultValue={raw.from} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="to">To</Label>
          <Input id="to" name="to" type="date" defaultValue={raw.to} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="voided">Voided</Label>
          <NativeSelect id="voided" name="voided" defaultValue={raw.voided}>
            <option value="">Show</option>
            <option value="hide">Hide</option>
          </NativeSelect>
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="outline">
            Apply
          </Button>
          {filtered ? (
            <Link
              href="/transactions"
              className={buttonVariants({ variant: "ghost" })}
            >
              Clear
            </Link>
          ) : null}
        </div>
      </form>
      <TransactionList
        transactions={transactions.map((t) =>
          toTransactionView(t, lookups, filters.accountId),
        )}
        empty={
          filtered ? (
            "No transactions match these filters."
          ) : (
            <>
              No transactions yet.{" "}
              <TextLink href="/transactions/new">
                Record your first one
              </TextLink>
              .
            </>
          )
        }
      />
      {transactions.length >= 200 ? (
        <p className="text-xs text-muted-foreground">
          Showing the 200 most recent matches. Narrow the filters to see older
          ones.
        </p>
      ) : null}
    </div>
  );
}
