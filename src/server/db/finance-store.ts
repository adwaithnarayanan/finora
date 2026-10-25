import type { CategoryKind, FinancialAccountType, RecordKind } from "@/domain/finance";
import { type LedgerDate, parseLedgerDate } from "@/domain/ledger";
import { type Currency, Money, defineCurrency } from "@/domain/money";
import type { OwnerId } from "@/domain/owner";
import type {
  CategoryRecord,
  FinanceStore,
  FinancialAccountRecord,
  SystemLedgerPurpose,
  TransactionFilters,
  TransactionRecord,
} from "@/server/finance/store";

import type { Prisma } from "./generated/client";
import { FinanceConflictError } from "@/server/finance/errors";
import { sqlStates } from "@/server/ledger/database-errors";

import type { ScopedTx } from "./scope";

/** Unique indexes that mean "this account name is taken" (case-insensitive and exact). */
const ACCOUNT_NAME_INDEXES = ["financial_accounts_owner_name_ci_key", "financial_accounts_owner_name_key"];

/**
 * True for a unique violation on one of `indexes`. Prisma's driver-adapter
 * errors carry the index name in nested metadata; only that is inspected.
 */
function isUniqueViolation(error: unknown, indexes: readonly string[]): boolean {
  if (!sqlStates(error).includes("23505")) return false;
  let text = "";
  try {
    text = JSON.stringify((error as { meta?: unknown }).meta ?? {});
  } catch {
    return false;
  }
  return indexes.some((index) => text.includes(index));
}

/** Runs a write, turning an account-name unique violation into the friendly conflict. */
async function withNameConflict<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error, ACCOUNT_NAME_INDEXES)) throw new FinanceConflictError("account-name-taken");
    throw error;
  }
}

const toDate = (date: LedgerDate) => new Date(`${date}T00:00:00.000Z`);
const fromDate = (date: Date) => parseLedgerDate(date.toISOString().slice(0, 10));

const accountSelect = {
  id: true,
  name: true,
  type: true,
  currencyCode: true,
  ledgerAccountId: true,
  creationKey: true,
  creationFingerprint: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  ledgerAccount: { select: { currency: { select: { code: true, exponent: true } } } },
} as const;

type AccountRow = Prisma.FinancialAccountGetPayload<{ select: typeof accountSelect }>;

function toAccount(row: AccountRow): FinancialAccountRecord {
  return Object.freeze({
    id: row.id,
    name: row.name,
    type: row.type,
    currency: defineCurrency(row.ledgerAccount.currency.code, row.ledgerAccount.currency.exponent),
    ledgerAccountId: row.ledgerAccountId,
    creationKey: row.creationKey,
    creationFingerprint: row.creationFingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  });
}

const categorySelect = { id: true, name: true, kind: true, createdAt: true, updatedAt: true, archivedAt: true } as const;

const transactionInclude = { replacedBy: { select: { id: true } } } as const;
type TransactionRow = Prisma.FinanceTransactionGetPayload<{ include: typeof transactionInclude }>;

/**
 * Prisma implementation of the finance store, bound to one owner-scoped
 * transaction (see `withFinanceStores`). RLS filters every statement; inserts
 * carry the owner id the RLS context holds (WITH CHECK).
 */
export class PrismaFinanceStore implements FinanceStore {
  private currencies: Map<string, Currency> | undefined;

  constructor(
    private readonly tx: ScopedTx,
    private readonly ownerId: OwnerId,
  ) {}

  private async currency(code: string): Promise<Currency> {
    if (!this.currencies) {
      const rows = await this.tx.currency.findMany();
      this.currencies = new Map(rows.map((r) => [r.code, defineCurrency(r.code, r.exponent)]));
    }
    const found = this.currencies.get(code);
    if (!found) throw new Error("Unknown currency in stored transaction");
    return found;
  }

  private async toTransaction(row: TransactionRow): Promise<TransactionRecord> {
    return Object.freeze({
      id: row.id,
      kind: row.kind,
      occurredOn: fromDate(row.occurredOn),
      amount: Money.ofMinor(row.amountMinor, await this.currency(row.currencyCode)),
      sourceAccountId: row.sourceAccountId,
      destinationAccountId: row.destinationAccountId,
      categoryId: row.categoryId,
      payee: row.payee,
      note: row.note,
      journalEntryId: row.journalEntryId,
      reversalEntryId: row.reversalEntryId,
      voidedAt: row.voidedAt,
      replacesTransactionId: row.replacesTransactionId,
      replacedByTransactionId: row.replacedBy?.id ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async lockKey(key: string): Promise<void> {
    // Include the owner so keys never contend across owners.
    await this.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${this.ownerId}:${key}`}, 0))`;
  }

  async listAccounts(): Promise<FinancialAccountRecord[]> {
    const rows = await this.tx.financialAccount.findMany({ select: accountSelect, orderBy: [{ name: "asc" }] });
    return rows.map(toAccount);
  }

  async findAccount(id: string): Promise<FinancialAccountRecord | null> {
    const row = await this.tx.financialAccount.findUnique({ where: { id }, select: accountSelect });
    return row ? toAccount(row) : null;
  }

  async lockAccount(id: string): Promise<FinancialAccountRecord | null> {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM finora.financial_accounts WHERE id = ${id}::uuid FOR UPDATE`;
    return locked.length === 0 ? null : this.findAccount(id);
  }

  async findAccountByCreationKey(key: string): Promise<FinancialAccountRecord | null> {
    const row = await this.tx.financialAccount.findUnique({
      where: { ownerId_creationKey: { ownerId: this.ownerId, creationKey: key } },
      select: accountSelect,
    });
    return row ? toAccount(row) : null;
  }

  async accountNameTaken(name: string, exceptId?: string): Promise<boolean> {
    // Same comparison as the financial_accounts_owner_name_ci_key index
    // ((owner_id, lower(name))); not ILIKE, where "_" and "%" would act as
    // wildcards. The explicit owner filter is in addition to RLS, not instead.
    const rows = await this.tx.$queryRaw<{ taken: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM finora.financial_accounts
         WHERE owner_id = ${this.ownerId}::uuid
           AND lower(name) = lower(${name})
           AND id IS DISTINCT FROM ${exceptId ?? null}::uuid
      ) AS taken`;
    return rows[0]?.taken === true;
  }

  async insertAccount(row: {
    id: string;
    name: string;
    type: FinancialAccountType;
    currencyCode: string;
    ledgerAccountId: string;
    creationKey: string;
    creationFingerprint: string;
  }): Promise<FinancialAccountRecord> {
    const created = await withNameConflict(() =>
      this.tx.financialAccount.create({ data: { ...row, ownerId: this.ownerId }, select: accountSelect }),
    );
    return toAccount(created);
  }

  async updateAccount(id: string, changes: { name: string; type: FinancialAccountType }): Promise<void> {
    await withNameConflict(() => this.tx.financialAccount.updateMany({ where: { id }, data: changes }));
  }

  async setAccountArchived(id: string, archived: boolean): Promise<void> {
    await this.tx.$executeRaw`
      UPDATE finora.financial_accounts SET archived_at = CASE WHEN ${archived} THEN now() END WHERE id = ${id}::uuid`;
  }

  async deleteAccount(id: string, ledgerAccountId: string): Promise<void> {
    await this.tx.financialAccount.deleteMany({ where: { id } });
    await this.tx.ledgerAccount.deleteMany({ where: { id: ledgerAccountId } });
  }

  async ledgerAccountHasLines(ledgerAccountId: string): Promise<boolean> {
    return (await this.tx.journalLine.count({ where: { accountId: ledgerAccountId } })) > 0;
  }

  async listCategories(): Promise<CategoryRecord[]> {
    return this.tx.category.findMany({ select: categorySelect, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  }

  async findCategory(id: string): Promise<CategoryRecord | null> {
    return this.tx.category.findUnique({ where: { id }, select: categorySelect });
  }

  async categoryNameTaken(kind: CategoryKind, name: string, exceptId?: string): Promise<boolean> {
    const count = await this.tx.category.count({
      where: { kind, name: { equals: name, mode: "insensitive" }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    });
    return count > 0;
  }

  async insertCategory(row: { name: string; kind: CategoryKind }): Promise<CategoryRecord> {
    return this.tx.category.create({ data: { ...row, ownerId: this.ownerId }, select: categorySelect });
  }

  async insertCategoriesIfMissing(rows: readonly { name: string; kind: CategoryKind }[]): Promise<number> {
    const { count } = await this.tx.category.createMany({
      data: rows.map((row) => ({ ...row, ownerId: this.ownerId })),
      skipDuplicates: true,
    });
    return count;
  }

  async renameCategory(id: string, name: string): Promise<void> {
    await this.tx.category.updateMany({ where: { id }, data: { name } });
  }

  async setCategoryArchived(id: string, archived: boolean): Promise<void> {
    await this.tx.$executeRaw`
      UPDATE finora.categories SET archived_at = CASE WHEN ${archived} THEN now() END WHERE id = ${id}::uuid`;
  }

  async findCategoryLedgerAccount(categoryId: string, currencyCode: string): Promise<string | null> {
    const row = await this.tx.categoryLedgerAccount.findUnique({
      where: { categoryId_ownerId_currencyCode: { categoryId, ownerId: this.ownerId, currencyCode } },
      select: { ledgerAccountId: true },
    });
    return row?.ledgerAccountId ?? null;
  }

  async insertCategoryLedgerAccount(categoryId: string, currencyCode: string, ledgerAccountId: string): Promise<void> {
    await this.tx.categoryLedgerAccount.create({
      data: { ownerId: this.ownerId, categoryId, currencyCode, ledgerAccountId },
      select: { categoryId: true },
    });
  }

  async findSystemLedgerAccount(purpose: SystemLedgerPurpose, currencyCode: string): Promise<string | null> {
    const row = await this.tx.systemLedgerAccount.findUnique({
      where: { ownerId_purpose_currencyCode: { ownerId: this.ownerId, purpose, currencyCode } },
      select: { ledgerAccountId: true },
    });
    return row?.ledgerAccountId ?? null;
  }

  async insertSystemLedgerAccount(purpose: SystemLedgerPurpose, currencyCode: string, ledgerAccountId: string): Promise<void> {
    await this.tx.systemLedgerAccount.create({
      data: { ownerId: this.ownerId, purpose, currencyCode, ledgerAccountId },
      select: { purpose: true },
    });
  }

  async insertTransaction(row: {
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
  }): Promise<TransactionRecord> {
    const created = await this.tx.financeTransaction.create({
      data: {
        ownerId: this.ownerId,
        kind: row.kind,
        occurredOn: toDate(row.occurredOn),
        amountMinor: row.amount.minor,
        currencyCode: row.amount.currency.code,
        sourceAccountId: row.sourceAccountId,
        destinationAccountId: row.destinationAccountId,
        categoryId: row.categoryId,
        payee: row.payee,
        note: row.note,
        journalEntryId: row.journalEntryId,
        replacesTransactionId: row.replacesTransactionId,
      },
      include: transactionInclude,
    });
    return this.toTransaction(created);
  }

  async findTransaction(id: string): Promise<TransactionRecord | null> {
    const row = await this.tx.financeTransaction.findUnique({ where: { id }, include: transactionInclude });
    return row ? this.toTransaction(row) : null;
  }

  async lockTransaction(id: string): Promise<TransactionRecord | null> {
    const locked = await this.tx.$queryRaw<{ id: string }[]>`
      SELECT id::text FROM finora.transactions WHERE id = ${id}::uuid FOR UPDATE`;
    return locked.length === 0 ? null : this.findTransaction(id);
  }

  async findTransactionByEntry(journalEntryId: string): Promise<TransactionRecord | null> {
    const row = await this.tx.financeTransaction.findUnique({
      where: { journalEntryId_ownerId: { journalEntryId, ownerId: this.ownerId } },
      include: transactionInclude,
    });
    return row ? this.toTransaction(row) : null;
  }

  async activeOpeningBalance(accountId: string): Promise<TransactionRecord | null> {
    const row = await this.tx.financeTransaction.findFirst({
      where: { kind: "opening_balance", destinationAccountId: accountId, voidedAt: null },
      include: transactionInclude,
    });
    return row ? this.toTransaction(row) : null;
  }

  async linkVoid(id: string, reversalEntryId: string): Promise<void> {
    await this.tx.financeTransaction.updateMany({ where: { id, reversalEntryId: null }, data: { reversalEntryId } });
  }

  async updateTransactionDetails(id: string, details: { payee: string | null; note: string | null }): Promise<void> {
    await this.tx.financeTransaction.updateMany({ where: { id }, data: details });
  }

  async listTransactions(filters: TransactionFilters): Promise<TransactionRecord[]> {
    const where: Prisma.FinanceTransactionWhereInput = {
      ...(filters.includeVoided ? {} : { voidedAt: null }),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.from || filters.to
        ? {
            occurredOn: {
              ...(filters.from ? { gte: toDate(filters.from) } : {}),
              ...(filters.to ? { lte: toDate(filters.to) } : {}),
            },
          }
        : {}),
      AND: [
        ...(filters.accountId
          ? [{ OR: [{ sourceAccountId: filters.accountId }, { destinationAccountId: filters.accountId }] }]
          : []),
        ...(filters.search
          ? [
              {
                OR: [
                  { payee: { contains: filters.search, mode: "insensitive" as const } },
                  { note: { contains: filters.search, mode: "insensitive" as const } },
                ],
              },
            ]
          : []),
      ],
    };
    const rows = await this.tx.financeTransaction.findMany({
      where,
      include: transactionInclude,
      orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
      take: filters.limit,
    });
    return Promise.all(rows.map((row) => this.toTransaction(row)));
  }
}
