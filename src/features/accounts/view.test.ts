import { describe, expect, it } from "vitest";

import { type FinancialAccountType, accountLifecycle } from "@/domain/finance";
import { parseLedgerDate } from "@/domain/ledger";
import { INR, Money } from "@/domain/money";
import type { FinancialAccountRecord, TransactionRecord } from "@/server/finance";

import { lookupsFrom, toTransactionView } from "../transactions/view";
import { formatAccountBalance, toAccountOptions, toAccountView } from "./view";

const inr = (amount: string) => Money.parse(amount, INR);

function record(type: FinancialAccountType, extra: Partial<FinancialAccountRecord> = {}): FinancialAccountRecord {
  const at = new Date("2026-10-25T00:00:00Z");
  return {
    id: `id-${type}`,
    name: type === "credit_card" ? "HDFC Card" : "Axis Savings",
    type,
    currency: INR,
    ledgerAccountId: `ledger-${type}`,
    creationKey: "key",
    creationFingerprint: "0".repeat(64),
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...extra,
  };
}

const summary = (account: FinancialAccountRecord, balance: Money) => ({
  account,
  balance,
  hasHistory: true,
  lifecycle: accountLifecycle({ archived: account.archivedAt !== null, hasHistory: true }),
});

describe("account balances for display", () => {
  it("shows an asset's normal balance as an amount, flagging an overdraft", () => {
    expect(formatAccountBalance("asset", inr("50000"))).toBe("₹50,000.00");
    expect(toAccountView(summary(record("bank"), inr("-20")))).toMatchObject({ balance: "-₹20.00", negative: true, ledgerKind: "asset" });
  });

  it("shows a credit card's liability balance as owed, a credit in the owner's favour, or nothing owed", () => {
    expect(formatAccountBalance("liability", inr("12000"))).toBe("Owed ₹12,000.00");
    expect(formatAccountBalance("liability", inr("-500"))).toBe("Credit balance ₹500.00");
    expect(formatAccountBalance("liability", inr("0"))).toBe("Nothing owed (₹0.00)");
    expect(formatAccountBalance("liability", inr("125000"))).toBe("Owed ₹1,25,000.00");
    const view = toAccountView(summary(record("credit_card"), inr("12000")));
    expect(view).toMatchObject({ typeLabel: "Credit card", ledgerKind: "liability", balance: "Owed ₹12,000.00", negative: false });
  });

  it("offers only active bank and cash accounts to transaction pickers", () => {
    const options = toAccountOptions([
      summary(record("bank"), inr("10")),
      summary(record("cash", { id: "id-archived", archivedAt: new Date("2026-10-25T01:00:00Z") }), inr("1")),
      summary(record("credit_card"), inr("12000")),
    ]);
    expect(options.map((o) => o.id)).toEqual(["id-bank"]);
  });

  it("shows a card's opening amount owed as money out, and an asset's opening balance as money in", () => {
    const card = record("credit_card");
    const bank = record("bank");
    const lookups = lookupsFrom([card, bank], []);
    const opening = (destinationAccountId: string): TransactionRecord => ({
      id: `t-${destinationAccountId}`,
      kind: "opening_balance",
      occurredOn: parseLedgerDate("2026-10-25"),
      amount: inr("12000"),
      sourceAccountId: null,
      destinationAccountId,
      categoryId: null,
      payee: null,
      note: null,
      journalEntryId: "e",
      reversalEntryId: null,
      voidedAt: null,
      replacesTransactionId: null,
      replacedByTransactionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(toTransactionView(opening(card.id), lookups, card.id)).toMatchObject({ direction: -1, amount: "₹12,000.00", accounts: "HDFC Card" });
    expect(toTransactionView(opening(bank.id), lookups, bank.id).direction).toBe(1);
  });
});
