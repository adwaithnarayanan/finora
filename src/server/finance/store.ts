import type { AccountName, CategoryKind, FinancialAccountType, RecordKind } from "@/domain/finance";
import type { LedgerDate } from "@/domain/ledger";
import type { Currency, Money } from "@/domain/money";

export interface FinancialAccountRecord {
  readonly id: string;
  readonly name: string;
  readonly type: FinancialAccountType;
  readonly currency: Currency;
  readonly ledgerAccountId: string;
  readonly creationKey: string;
  readonly creationFingerprint: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface CategoryRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: CategoryKind;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface TransactionRecord {
  readonly id: string;
  readonly kind: RecordKind;
  readonly occurredOn: LedgerDate;
  readonly amount: Money;
  readonly sourceAccountId: string | null;
  readonly destinationAccountId: string | null;
  readonly categoryId: string | null;
  readonly payee: string | null;
  readonly note: string | null;
  readonly journalEntryId: string;
  readonly reversalEntryId: string | null;
  readonly voidedAt: Date | null;
  readonly replacesTransactionId: string | null;
  readonly replacedByTransactionId: string | null;
  /** On a card refund: the recorded purchase it refunds, if any (ADR 0008). */
  readonly refundsTransactionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A card purchase with how much of it its still-active refunds cover. */
export interface RefundedPurchaseRow {
  readonly purchase: TransactionRecord;
  /** Sum of the purchase's non-voided refunds, in its minor units. */
  readonly refundedMinor: bigint;
}

export interface TransactionFilters {
  readonly from?: LedgerDate;
  readonly to?: LedgerDate;
  readonly kind?: RecordKind;
  readonly accountId?: string;
  readonly categoryId?: string;
  /** Case-insensitive match on payee or note. */
  readonly search?: string;
  readonly includeVoided: boolean;
  readonly limit: number;
}

export type SystemLedgerPurpose = "opening_balance_equity";

/**
 * Persistence port for the finance service. Like LedgerStore, every instance
 * is bound to one owner-scoped transaction (RLS context set), never takes an
 * owner id from callers, and every read is owner-filtered.
 */
export interface FinanceStore {
  /** Transaction-scoped advisory lock serialising work on one logical key. */
  lockKey(key: string): Promise<void>;

  listAccounts(): Promise<FinancialAccountRecord[]>;
  findAccount(id: string): Promise<FinancialAccountRecord | null>;
  /** Like findAccount, but locks the row until the transaction ends. */
  lockAccount(id: string): Promise<FinancialAccountRecord | null>;
  findAccountByCreationKey(key: string): Promise<FinancialAccountRecord | null>;
  /** True if another of this owner's accounts has the same comparison key. */
  accountNameTaken(name: AccountName, exceptId?: string): Promise<boolean>;
  /** Stores `name.display` as the name and `name.key` as its comparison key. */
  insertAccount(row: {
    id: string;
    name: AccountName;
    type: FinancialAccountType;
    currencyCode: string;
    ledgerAccountId: string;
    creationKey: string;
    creationFingerprint: string;
  }): Promise<FinancialAccountRecord>;
  updateAccount(id: string, changes: { name: AccountName; type: FinancialAccountType }): Promise<void>;
  setAccountArchived(id: string, archived: boolean): Promise<void>;
  /** Deletes the account and then its (unused) ledger account. */
  deleteAccount(id: string, ledgerAccountId: string): Promise<void>;
  ledgerAccountHasLines(ledgerAccountId: string): Promise<boolean>;

  listCategories(): Promise<CategoryRecord[]>;
  findCategory(id: string): Promise<CategoryRecord | null>;
  categoryNameTaken(kind: CategoryKind, name: string, exceptId?: string): Promise<boolean>;
  insertCategory(row: { name: string; kind: CategoryKind }): Promise<CategoryRecord>;
  /** Inserts the ones that do not exist yet (by kind and name); returns how many were inserted. */
  insertCategoriesIfMissing(rows: readonly { name: string; kind: CategoryKind }[]): Promise<number>;
  renameCategory(id: string, name: string): Promise<void>;
  setCategoryArchived(id: string, archived: boolean): Promise<void>;
  findCategoryLedgerAccount(categoryId: string, currencyCode: string): Promise<string | null>;
  insertCategoryLedgerAccount(categoryId: string, currencyCode: string, ledgerAccountId: string): Promise<void>;
  findSystemLedgerAccount(purpose: SystemLedgerPurpose, currencyCode: string): Promise<string | null>;
  insertSystemLedgerAccount(purpose: SystemLedgerPurpose, currencyCode: string, ledgerAccountId: string): Promise<void>;

  insertTransaction(row: {
    kind: RecordKind;
    occurredOn: LedgerDate;
    amount: Money;
    sourceAccountId: string | null;
    destinationAccountId: string | null;
    categoryId: string | null;
    payee: string | null;
    note: string | null;
    journalEntryId: string;
    replacesTransactionId: string | null;
    refundsTransactionId: string | null;
  }): Promise<TransactionRecord>;
  findTransaction(id: string): Promise<TransactionRecord | null>;
  lockTransaction(id: string): Promise<TransactionRecord | null>;
  findTransactionByEntry(journalEntryId: string): Promise<TransactionRecord | null>;
  activeOpeningBalance(accountId: string): Promise<TransactionRecord | null>;
  /** Links the posted reversal; the database stamps voided_at. */
  linkVoid(id: string, reversalEntryId: string): Promise<void>;
  updateTransactionDetails(id: string, details: { payee: string | null; note: string | null }): Promise<void>;
  listTransactions(filters: TransactionFilters): Promise<TransactionRecord[]>;

  /**
   * Total of the still-active (non-voided) refunds of `purchaseId`, in that
   * transaction's minor units; 0 when there are none. Callers that are about
   * to write a refund must hold the purchase row (`lockTransaction`) first,
   * or two concurrent refunds can both read the same total (ADR 0008).
   */
  refundedMinor(purchaseId: string): Promise<bigint>;
  /** Every refund of `purchaseId`, voided ones included, oldest first. */
  listRefunds(purchaseId: string): Promise<TransactionRecord[]>;
  /**
   * Active expenses paid by an active credit card, newest first, each with
   * its refunded total: the candidates for a linked refund.
   */
  listRefundablePurchases(): Promise<RefundedPurchaseRow[]>;
}
