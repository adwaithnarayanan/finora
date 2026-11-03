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

  it("offers active accounts to transaction pickers, marking cards and showing a card's balance as owed", () => {
    const options = toAccountOptions([
      summary(record("bank"), inr("10")),
      summary(record("cash", { id: "id-archived", archivedAt: new Date("2026-10-25T01:00:00Z") }), inr("1")),
      summary(record("credit_card"), inr("12000")),
      summary(record("credit_card", { id: "id-archived-card", archivedAt: new Date("2026-10-25T01:00:00Z") }), inr("1")),
    ]);
    expect(options).toEqual([
      { id: "id-bank", label: "Axis Savings (₹10.00)", currencyCode: "INR", exponent: 2, card: false },
      { id: "id-credit_card", label: "HDFC Card (Owed ₹12,000.00)", currencyCode: "INR", exponent: 2, card: true },
    ]);
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
      refundsTransactionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(toTransactionView(opening(card.id), lookups, card.id)).toMatchObject({ direction: -1, amount: "₹12,000.00", accounts: "HDFC Card" });
    expect(toTransactionView(opening(bank.id), lookups, bank.id).direction).toBe(1);
  });
  it("shows an expense paid by card as money out of the card, with its date, category, payee and note", () => {
    const card = record("credit_card");
    const at = new Date("2026-10-25T00:00:00Z");
    const lookups = lookupsFrom([card], [{ id: "cat-shopping", name: "Shopping", kind: "expense", createdAt: at, updatedAt: at, archivedAt: null }]);
    const purchase: TransactionRecord = {
      id: "t-purchase",
      kind: "expense",
      occurredOn: parseLedgerDate("2026-10-24"),
      amount: inr("1250"),
      sourceAccountId: card.id,
      destinationAccountId: null,
      categoryId: "cat-shopping",
      payee: "Bata",
      note: "Shoes",
      journalEntryId: "e",
      reversalEntryId: null,
      voidedAt: null,
      replacesTransactionId: null,
      replacedByTransactionId: null,
      refundsTransactionId: null,
      createdAt: at,
      updatedAt: at,
    };
    expect(toTransactionView(purchase, lookups, card.id)).toMatchObject({
      kind: "expense",
      title: "Shopping",
      accounts: "HDFC Card",
      amount: "₹1,250.00",
      direction: -1,
      date: "2026-10-24",
      payee: "Bata",
      note: "Shoes",
    });
  });
});
