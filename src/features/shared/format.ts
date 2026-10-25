import type { Money } from "@/domain/money";

/** Display rules: en-IN grouping, the currency's own minor digits. */
export function formatMoney(amount: Money): string {
  return amount.format({ locale: "en-IN" });
}

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A ledger date (YYYY-MM-DD) for display, e.g. "25 Oct 2026". */
export function formatLedgerDate(date: string): string {
  return DATE.format(new Date(`${date}T00:00:00Z`));
}

/** Today's date in India (YYYY-MM-DD), the default for new entries. */
export function todayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}
