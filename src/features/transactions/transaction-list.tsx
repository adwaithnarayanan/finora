import Link from "next/link";

import { Badge } from "@/components/ui/badge";

import type { TransactionView } from "./view";

const SIGN = { 1: "+", [-1]: "−", 0: "" } as const;

export function TransactionList({ transactions, empty }: { transactions: readonly TransactionView[]; empty: React.ReactNode }) {
  if (transactions.length === 0) {
    return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <ul className="divide-y rounded-lg border" aria-label="Transactions">
      {transactions.map((t) => (
        <li key={t.id}>
          <Link
            href={`/transactions/${t.id}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className={t.voided ? "font-medium line-through" : "font-medium"}>{t.title}</span>
                <Badge variant="outline">{t.kindLabel}</Badge>
                {t.voided ? <Badge variant="destructive">{t.corrected ? "Corrected" : "Void"}</Badge> : null}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {t.dateLabel} · {t.accounts}
                {t.payee ? ` · ${t.payee}` : ""}
                {t.note ? ` · ${t.note}` : ""}
              </span>
            </span>
            <span
              className={[
                "font-medium tabular-nums",
                t.voided ? "text-muted-foreground line-through" : t.direction === 1 ? "text-emerald-700 dark:text-emerald-400" : "",
              ].join(" ")}
            >
              <span className="sr-only">{t.direction === 1 ? "In: " : t.direction === -1 ? "Out: " : ""}</span>
              {SIGN[t.direction]}
              {t.amount}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
