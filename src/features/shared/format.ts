import type { Money } from "@/domain/money";

export function formatMoney(amount: Money): string {
  return amount.format({ locale: "en-IN" });
}

const DATE = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatLedgerDate(date: string): string {
  return DATE.format(new Date(`${date}T00:00:00Z`));
}

export function todayInIndia(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    now,
  );
}
