import { createHash, randomUUID } from "node:crypto";

import {
  ACCOUNT_LEDGER_KIND,
  type AccountLifecycle,
  type AccountRef,
  type CategoryRef,
  DEFAULT_CATEGORIES,
  DEFAULT_CURRENCY_CODE,
  FinanceValidationError,
  type FinancialAccountType,
  IssueCollector,
  type PostingPlan,
  type PurchaseRef,
  type TransactionIntent,
  accountLifecycle,
  isTwoSided,
  parseAccountName,
  parseAccountType,
  parseAccountTypeChange,
  parseAmountFor,
  parseCategoryKind,
  parseName,
  parseNote,
  parsePayee,
  checkRefundAmount,
  checkRefundablePurchase,
  parseTransactionIntent,
  planOpeningBalance,
  planTransaction,
  remainingRefundable,
  requiredCategoryKind,
} from "@/domain/finance";
import {
  type LedgerDate,
  parseIdempotencyKey,
  parseLedgerDate,
} from "@/domain/ledger";
import { Money } from "@/domain/money";
import { isCanonicalUuid } from "@/domain/shared/uuid";
import type { AuthorizedOwner } from "@/server/auth/types";
import { IdempotencyConflictError } from "@/server/ledger/errors";
import { ledgerOperations, runTranslated } from "@/server/ledger/service";
import type { LedgerStore } from "@/server/ledger/store";

import { FinanceConflictError, FinanceNotFoundError } from "./errors";
import type {
  CategoryRecord,
  FinanceStore,
  FinancialAccountRecord,
  TransactionFilters,
  TransactionRecord,
} from "./store";

export type FinanceStores = {
  readonly ledger: LedgerStore;
  readonly finance: FinanceStore;
};

export type FinanceRunner = <T>(
  owner: AuthorizedOwner,
  work: (stores: FinanceStores) => Promise<T>,
) => Promise<T>;

export interface AccountSummary {
  readonly account: FinancialAccountRecord;
  readonly balance: Money;
  readonly hasHistory: boolean;
  readonly lifecycle: AccountLifecycle;
}

export interface AccountDetail extends AccountSummary {
  readonly openingBalance: TransactionRecord | null;
}

export interface RefundablePurchase {
  readonly purchase: TransactionRecord;
  readonly refunded: Money;
  readonly remaining: Money;
}

export interface PurchaseRefunds extends RefundablePurchase {
  readonly refunds: readonly TransactionRecord[];
}

export interface Replayable<T> {
  readonly value: T;
  readonly replayed: boolean;
}

const MAX_REQUEST_KEY_LENGTH = 100;

const fieldError = (field: string, message: string) =>
  new FinanceValidationError([{ field, message }]);

function parseRequestKey(value: unknown): string {
  let key: string;
  try {
    key = parseIdempotencyKey(value);
  } catch {
    throw fieldError(
      "idempotencyKey",
      "The form expired; reload the page and try again",
    );
  }
  if (key.length > MAX_REQUEST_KEY_LENGTH)
    throw fieldError("idempotencyKey", "Request key is too long");
  return key;
}

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const ledgerName = {
  account: (id: string) => `account:${id}`,
  category: (id: string, currency: string) => `category:${id}:${currency}`,
  openingEquity: (currency: string) =>
    `system:opening-balance-equity:${currency}`,
};

function toAccountRef(account: FinancialAccountRecord): AccountRef {
  return {
    id: account.id,
    name: account.name,
    ledgerAccountId: account.ledgerAccountId,
    ledgerKind: ACCOUNT_LEDGER_KIND[account.type],
    currency: account.currency,
    archived: account.archivedAt !== null,
  };
}

function toCategoryRef(category: CategoryRecord): CategoryRef {
  return {
    id: category.id,
    name: category.name,
    kind: category.kind,
    archived: category.archivedAt !== null,
  };
}

function toPurchaseRef(purchase: TransactionRecord): PurchaseRef {
  return {
    id: purchase.id,
    kind: purchase.kind,
    paidByAccountId: purchase.sourceAccountId,
    amount: purchase.amount,
    voided: purchase.voidedAt !== null,
  };
}

async function categoryLedgerAccount(
  { ledger, finance }: FinanceStores,
  category: CategoryRecord,
  currencyCode: string,
): Promise<string> {
  const existing = await finance.findCategoryLedgerAccount(
    category.id,
    currencyCode,
  );
  if (existing) return existing;
  await finance.lockKey(`category-ledger:${category.id}:${currencyCode}`);
  const raced = await finance.findCategoryLedgerAccount(
    category.id,
    currencyCode,
  );
  if (raced) return raced;
  const account = await ledgerOperations.createAccount(ledger, {
    name: ledgerName.category(category.id, currencyCode),
    kind: category.kind,
    currency: currencyCode,
  });
  await finance.insertCategoryLedgerAccount(
    category.id,
    currencyCode,
    account.id,
  );
  return account.id;
}

async function openingEquityAccount(
  { ledger, finance }: FinanceStores,
  currencyCode: string,
): Promise<string> {
  const existing = await finance.findSystemLedgerAccount(
    "opening_balance_equity",
    currencyCode,
  );
  if (existing) return existing;
  await finance.lockKey(`opening-equity:${currencyCode}`);
  const raced = await finance.findSystemLedgerAccount(
    "opening_balance_equity",
    currencyCode,
  );
  if (raced) return raced;
  const account = await ledgerOperations.createAccount(ledger, {
    name: ledgerName.openingEquity(currencyCode),
    kind: "equity",
    currency: currencyCode,
  });
  await finance.insertSystemLedgerAccount(
    "opening_balance_equity",
    currencyCode,
    account.id,
  );
  return account.id;
}

async function postedBalance(
  stores: FinanceStores,
  account: FinancialAccountRecord,
): Promise<Money> {
  const { balance } = await ledgerOperations.accountBalance(
    stores.ledger,
    account.ledgerAccountId,
  );
  return balance.normal;
}

async function summarize(
  stores: FinanceStores,
  account: FinancialAccountRecord,
): Promise<AccountSummary> {
  const hasHistory = await stores.finance.ledgerAccountHasLines(
    account.ledgerAccountId,
  );
  return {
    account,
    balance: await postedBalance(stores, account),
    hasHistory,
    lifecycle: accountLifecycle({
      archived: account.archivedAt !== null,
      hasHistory,
    }),
  };
}

async function mustFind<T>(
  resource: ConstructorParameters<typeof FinanceNotFoundError>[0],
  id: string,
  find: (id: string) => Promise<T | null>,
): Promise<T> {
  const found = isCanonicalUuid(id) ? await find(id) : null;
  if (!found) throw new FinanceNotFoundError(resource);
  return found;
}

const mustFindAccount = (finance: FinanceStore, id: string, lock = false) =>
  mustFind("account", id, (i) =>
    lock ? finance.lockAccount(i) : finance.findAccount(i),
  );

const mustFindTransaction = (finance: FinanceStore, id: string, lock = false) =>
  mustFind("transaction", id, (i) =>
    lock ? finance.lockTransaction(i) : finance.findTransaction(i),
  );

const mustFindCategory = (finance: FinanceStore, id: string) =>
  mustFind("category", id, (i) => finance.findCategory(i));

async function postAndRecord(
  stores: FinanceStores,
  plan: PostingPlan,
  key: string,
  record: Omit<
    Parameters<FinanceStore["insertTransaction"]>[0],
    "kind" | "occurredOn" | "amount" | "journalEntryId"
  >,
): Promise<Replayable<TransactionRecord>> {
  const { entry, replayed } = await ledgerOperations.postEntry(stores.ledger, {
    entryDate: plan.date,
    description: plan.description,
    lines: plan.lines,
    idempotencyKey: key,
  });
  if (replayed) {
    const existing = await stores.finance.findTransactionByEntry(entry.id);
    if (!existing) throw new IdempotencyConflictError();
    return { value: existing, replayed: true };
  }
  const value = await stores.finance.insertTransaction({
    ...record,
    kind: plan.kind,
    occurredOn: plan.date,
    amount: plan.amount,
    journalEntryId: entry.id,
  });
  return { value, replayed: false };
}

/**
 * v1 account-creation fingerprint. `name` is the submitted name after
 * `trim()` only, NOT the canonical (NFC) display name: v1 fingerprints were
 * recorded that way before ADR 0007, and the account-name migration rewrote
 * stored names to NFC without touching them, so an identical retry of an
 * earlier non-NFC request must still match. Changing what is hashed needs a
 * new version tag, never a redefinition of "v1".
 */
function accountFingerprint(input: {
  name: string;
  type: FinancialAccountType;
  currency: string;
  opening: { amount: string; date: string } | null;
}): string {
  return sha256(
    JSON.stringify([
      "v1",
      input.name,
      input.type,
      input.currency,
      input.opening?.amount ?? null,
      input.opening?.date ?? null,
    ]),
  );
}

export function createFinanceService(run: FinanceRunner) {
  const inTransaction = <T>(
    owner: AuthorizedOwner,
    work: (stores: FinanceStores) => Promise<T>,
  ): Promise<T> => runTranslated(() => run(owner, work));

  async function postOpeningBalance(
    stores: FinanceStores,
    account: FinancialAccountRecord,
    opening: { amount: string; date: unknown },
    key: string,
  ): Promise<Replayable<TransactionRecord>> {
    const equity = await openingEquityAccount(stores, account.currency.code);
    const plan = planOpeningBalance({
      account: toAccountRef(account),
      ...opening,
      equityLedgerAccountId: equity,
    });
    return postAndRecord(stores, plan, key, {
      sourceAccountId: null,
      destinationAccountId: account.id,
      categoryId: null,
      payee: null,
      note: null,
      replacesTransactionId: null,
      refundsTransactionId: null,
    });
  }

  return {
    async listAccounts(owner: AuthorizedOwner): Promise<AccountSummary[]> {
      return inTransaction(owner, async (stores) => {
        const accounts = await stores.finance.listAccounts();
        return Promise.all(
          accounts.map((account) => summarize(stores, account)),
        );
      });
    },

    async getAccount(
      owner: AuthorizedOwner,
      id: string,
    ): Promise<AccountDetail> {
      return inTransaction(owner, async (stores) => {
        const account = await mustFindAccount(stores.finance, id);
        return {
          ...(await summarize(stores, account)),
          openingBalance: await stores.finance.activeOpeningBalance(account.id),
        };
      });
    },

    async createAccount(
      owner: AuthorizedOwner,
      input: {
        readonly name: unknown;
        readonly type: unknown;
        readonly currency?: unknown;
        readonly openingBalance?: {
          readonly amount: string;
          readonly date: unknown;
        } | null;
        readonly idempotencyKey: unknown;
      },
    ): Promise<Replayable<FinancialAccountRecord>> {
      const issues = new IssueCollector();
      const name = issues.capture("name", () => parseAccountName(input.name));
      const type = issues.capture("type", () => parseAccountType(input.type));
      const currencyCode =
        input.currency === undefined || input.currency === ""
          ? DEFAULT_CURRENCY_CODE
          : input.currency;
      if (typeof currencyCode !== "string" || !/^[A-Z]{3}$/.test(currencyCode))
        issues.add("currency", "Choose a currency");
      const opening =
        input.openingBalance && input.openingBalance.amount.trim() !== ""
          ? input.openingBalance
          : null;
      if (opening)
        issues.capture("openingDate", () => parseLedgerDate(opening.date));
      issues.throwIfAny();
      const key = parseRequestKey(input.idempotencyKey);
      const fingerprint = accountFingerprint({
        name: (input.name as string).trim(), // parseAccountName accepted it, so it is a string
        type: type!,
        currency: currencyCode as string,
        opening: opening
          ? { amount: opening.amount.trim(), date: String(opening.date) }
          : null,
      });

      return inTransaction(owner, async (stores) => {
        await stores.finance.lockKey(`create-account:${key}`);
        const previous = await stores.finance.findAccountByCreationKey(key);
        if (previous) {
          if (previous.creationFingerprint !== fingerprint)
            throw new IdempotencyConflictError();
          return { value: previous, replayed: true };
        }
        const currency = await stores.ledger.findCurrency(
          currencyCode as string,
        );
        if (!currency)
          throw fieldError("currency", "That currency is not supported");
        if (opening) {
          const issues = new IssueCollector();
          parseAmountFor(issues, "openingAmount", opening.amount.trim(), {
            id: "",
            name: name!.display,
            ledgerAccountId: "",
            ledgerKind: ACCOUNT_LEDGER_KIND[type!],
            currency,
            archived: false,
          });
          issues.throwIfAny();
        }
        // Serialise requests for the same comparison key (any letter case or
        await stores.finance.lockKey(`account-name:${name!.key}`);
        if (await stores.finance.accountNameTaken(name!))
          throw new FinanceConflictError("account-name-taken");

        const id = randomUUID();
        const ledgerAccount = await ledgerOperations.createAccount(
          stores.ledger,
          {
            name: ledgerName.account(id),
            kind: ACCOUNT_LEDGER_KIND[type!],
            currency: currencyCode as string,
          },
        );
        const account = await stores.finance.insertAccount({
          id,
          name: name!,
          type: type!,
          currencyCode: currencyCode as string,
          ledgerAccountId: ledgerAccount.id,
          creationKey: key,
          creationFingerprint: fingerprint,
        });
        if (opening)
          await postOpeningBalance(stores, account, opening, `${key}:opening`);
        return { value: account, replayed: false };
      });
    },

    async updateAccount(
      owner: AuthorizedOwner,
      id: string,
      input: { readonly name: unknown; readonly type: unknown },
    ): Promise<void> {
      const issues = new IssueCollector();
      const name = issues.capture("name", () => parseAccountName(input.name));
      issues.capture("type", () => parseAccountType(input.type));
      issues.throwIfAny();
      return inTransaction(owner, async ({ finance }) => {
        const account = await mustFindAccount(finance, id, true);
        const typeIssues = new IssueCollector();
        const type = typeIssues.capture("type", () =>
          parseAccountTypeChange(account.type, input.type),
        );
        typeIssues.throwIfAny();
        await finance.lockKey(`account-name:${name!.key}`);
        if (await finance.accountNameTaken(name!, account.id))
          throw new FinanceConflictError("account-name-taken");
        await finance.updateAccount(account.id, { name: name!, type: type! });
      });
    },

    async archiveAccount(owner: AuthorizedOwner, id: string): Promise<void> {
      return inTransaction(owner, async ({ finance }) => {
        const account = await mustFindAccount(finance, id, true);
        if (account.archivedAt === null)
          await finance.setAccountArchived(account.id, true);
      });
    },

    async restoreAccount(owner: AuthorizedOwner, id: string): Promise<void> {
      return inTransaction(owner, async ({ finance }) => {
        const account = await mustFindAccount(finance, id, true);
        if (account.archivedAt !== null)
          await finance.setAccountArchived(account.id, false);
      });
    },

    async deleteAccount(owner: AuthorizedOwner, id: string): Promise<void> {
      return inTransaction(owner, async ({ finance }) => {
        const account = await mustFindAccount(finance, id, true);
        if (await finance.ledgerAccountHasLines(account.ledgerAccountId))
          throw new FinanceConflictError("account-has-history");
        await finance.deleteAccount(account.id, account.ledgerAccountId);
      });
    },

    async setOpeningBalance(
      owner: AuthorizedOwner,
      accountId: string,
      input: {
        readonly amount: string;
        readonly date: unknown;
        readonly idempotencyKey: unknown;
      },
    ): Promise<Replayable<TransactionRecord>> {
      const key = parseRequestKey(input.idempotencyKey);
      return inTransaction(owner, async (stores) => {
        const account = await mustFindAccount(stores.finance, accountId, true);
        const current = await stores.finance.activeOpeningBalance(account.id);
        if (current) {
          const entry = await ledgerOperations.getEntry(
            stores.ledger,
            current.journalEntryId,
          );
          if (entry.idempotencyKey === key)
            return { value: current, replayed: true };
          throw new FinanceConflictError("opening-balance-exists");
        }
        return postOpeningBalance(stores, account, input, key);
      });
    },

    async correctOpeningBalance(
      owner: AuthorizedOwner,
      accountId: string,
      input: {
        readonly amount: string;
        readonly date: unknown;
        readonly idempotencyKey: unknown;
      },
    ): Promise<Replayable<TransactionRecord>> {
      const key = parseRequestKey(input.idempotencyKey);
      return inTransaction(owner, async (stores) => {
        const account = await mustFindAccount(stores.finance, accountId, true);
        const current = await stores.finance.activeOpeningBalance(account.id);
        if (!current) {
          // A replay after the correction committed finds the replacement active.
          throw new FinanceConflictError("no-opening-balance");
        }
        if (current.replacesTransactionId) {
          // Replay: the active balance is the replacement this key created
          const corrected = await stores.finance.findTransaction(
            current.replacesTransactionId,
          );
          const reversal = corrected?.reversalEntryId
            ? await ledgerOperations.getEntry(
                stores.ledger,
                corrected.reversalEntryId,
              )
            : null;
          if (reversal?.idempotencyKey === key)
            return { value: current, replayed: true };
        }

        const equity = await openingEquityAccount(
          stores,
          account.currency.code,
        );
        const plan = planOpeningBalance({
          account: toAccountRef(account),
          amount: input.amount,
          date: input.date,
          equityLedgerAccountId: equity,
        });
        const { reversal, replacement } = await ledgerOperations.correctEntry(
          stores.ledger,
          current.journalEntryId,
          {
            entryDate: plan.date,
            description: "Opening balance correction",
            idempotencyKey: key,
            replacement: {
              entryDate: plan.date,
              description: plan.description,
              lines: plan.lines,
            },
          },
        );
        await stores.finance.linkVoid(current.id, reversal.id);
        const value = await stores.finance.insertTransaction({
          kind: "opening_balance",
          occurredOn: plan.date,
          amount: plan.amount,
          sourceAccountId: null,
          destinationAccountId: account.id,
          categoryId: null,
          payee: null,
          note: null,
          journalEntryId: replacement.id,
          replacesTransactionId: current.id,
          refundsTransactionId: null,
        });
        return { value, replayed: false };
      });
    },

    async listCategories(owner: AuthorizedOwner): Promise<CategoryRecord[]> {
      return inTransaction(owner, ({ finance }) => finance.listCategories());
    },

    async initializeDefaultCategories(
      owner: AuthorizedOwner,
    ): Promise<{ readonly created: number }> {
      return inTransaction(owner, async ({ finance }) => {
        await finance.lockKey("default-categories");
        if ((await finance.listCategories()).length > 0) return { created: 0 };
        return {
          created: await finance.insertCategoriesIfMissing(DEFAULT_CATEGORIES),
        };
      });
    },

    async createCategory(
      owner: AuthorizedOwner,
      input: { readonly name: unknown; readonly kind: unknown },
    ): Promise<CategoryRecord> {
      const issues = new IssueCollector();
      const name = issues.capture("name", () =>
        parseName(input.name, "Category name"),
      );
      const kind = issues.capture("kind", () => parseCategoryKind(input.kind));
      issues.throwIfAny();
      return inTransaction(owner, async ({ finance }) => {
        await finance.lockKey(`category-name:${kind}`);
        if (await finance.categoryNameTaken(kind!, name!))
          throw new FinanceConflictError("category-name-taken");
        return finance.insertCategory({ name: name!, kind: kind! });
      });
    },

    async renameCategory(
      owner: AuthorizedOwner,
      id: string,
      input: { readonly name: unknown },
    ): Promise<void> {
      const issues = new IssueCollector();
      const name = issues.capture("name", () =>
        parseName(input.name, "Category name"),
      );
      issues.throwIfAny();
      return inTransaction(owner, async ({ finance }) => {
        const category = await mustFindCategory(finance, id);
        await finance.lockKey(`category-name:${category.kind}`);
        if (await finance.categoryNameTaken(category.kind, name!, category.id))
          throw new FinanceConflictError("category-name-taken");
        await finance.renameCategory(category.id, name!);
      });
    },

    async setCategoryArchived(
      owner: AuthorizedOwner,
      id: string,
      archived: boolean,
    ): Promise<void> {
      return inTransaction(owner, async ({ finance }) => {
        const category = await mustFindCategory(finance, id);
        await finance.setCategoryArchived(category.id, archived);
      });
    },

    async recordTransaction(
      owner: AuthorizedOwner,
      raw: Readonly<Record<string, unknown>> & {
        readonly idempotencyKey: unknown;
      },
    ): Promise<Replayable<TransactionRecord>> {
      const intent: TransactionIntent = parseTransactionIntent(raw);
      const key = parseRequestKey(raw.idempotencyKey);
      return inTransaction(owner, async (stores) => {
        const { finance } = stores;
        const source =
          "sourceAccountId" in intent
            ? await finance.findAccount(intent.sourceAccountId)
            : null;
        const destination =
          "destinationAccountId" in intent
            ? await finance.findAccount(intent.destinationAccountId)
            : null;
        const account = intent.kind === "expense" ? source : destination;

        /**
         * A linked card refund takes its category from the purchase, so the
         * credit lands on exactly the expense account the purchase debited.
         * The purchase row is LOCKED here, before its refunds are summed
         * below: that lock is what stops two concurrent refunds from both
         * fitting inside the same remaining amount. The database takes the
         * same lock and re-checks the total at COMMIT, so raw SQL through the
         * runtime role cannot get past it either (ADR 0008).
         */
        const linked =
          intent.kind === "card_refund" ? intent.refundsTransactionId : null;
        const purchase =
          linked === null
            ? null
            : await mustFindTransaction(finance, linked, true);
        /**
         * A key that was used before is a replay or a conflict, and either way
         * the refund rules were applied when the refund was first recorded.
         * They must NOT run again: the refund's own amount is part of the
         * total by now, so re-checking would refuse the replay of a refund
         * that finished off its purchase. postAndRecord resolves it instead,
         * returning the original or raising the conflict.
         */
        const replaying =
          purchase !== null &&
          (await stores.ledger.findByIdempotencyKey(
            parseIdempotencyKey(key),
          )) !== null;
        // Whether the purchase can be refunded at all is settled first: it
        const refunded =
          purchase && !replaying
            ? Money.ofMinor(
                await finance.refundedMinor(purchase.id),
                purchase.amount.currency,
              )
            : null;
        if (purchase && refunded && destination) {
          const issues = new IssueCollector();
          checkRefundablePurchase(issues, {
            purchase: toPurchaseRef(purchase),
            card: toAccountRef(destination),
            refunded,
          });
          issues.throwIfAny();
        }
        const categoryId = purchase
          ? purchase.categoryId
          : "categoryId" in intent
            ? intent.categoryId
            : null;

        const category =
          categoryId === null ? null : await finance.findCategory(categoryId);
        const neededKind = requiredCategoryKind(intent.kind);
        const categoryLedgerAccountId =
          category &&
          account &&
          category.kind === neededKind &&
          category.archivedAt === null
            ? await categoryLedgerAccount(
                stores,
                category,
                account.currency.code,
              )
            : undefined;
        const plan = planTransaction(intent, {
          ...(source ? { source: toAccountRef(source) } : {}),
          ...(destination ? { destination: toAccountRef(destination) } : {}),
          ...(category ? { category: toCategoryRef(category) } : {}),
          ...(categoryLedgerAccountId ? { categoryLedgerAccountId } : {}),
        });

        if (purchase && refunded) {
          const issues = new IssueCollector();
          checkRefundAmount(issues, {
            purchase: toPurchaseRef(purchase),
            amount: plan.amount,
            refunded,
          });
          issues.throwIfAny();
        }

        return postAndRecord(stores, plan, key, {
          sourceAccountId: source?.id ?? null,
          destinationAccountId: destination?.id ?? null,
          categoryId: category?.id ?? null,
          payee: "payee" in intent ? intent.payee : null,
          note: intent.note,
          replacesTransactionId: null,
          refundsTransactionId: purchase?.id ?? null,
        });
      });
    },

    async voidTransaction(
      owner: AuthorizedOwner,
      id: string,
      input: { readonly date: unknown; readonly idempotencyKey: unknown },
    ): Promise<Replayable<TransactionRecord>> {
      const key = parseRequestKey(input.idempotencyKey);
      const date: LedgerDate = (() => {
        const issues = new IssueCollector();
        const parsed = issues.capture("date", () =>
          parseLedgerDate(input.date),
        );
        issues.throwIfAny();
        return parsed!;
      })();
      return inTransaction(owner, async (stores) => {
        const transaction = await mustFindTransaction(stores.finance, id, true);
        if (transaction.reversalEntryId) {
          const reversal = await ledgerOperations.getEntry(
            stores.ledger,
            transaction.reversalEntryId,
          );
          if (reversal.idempotencyKey === key)
            return { value: transaction, replayed: true };
          throw new FinanceConflictError("already-voided");
        }
        if (transaction.replacedByTransactionId)
          throw new FinanceConflictError("already-voided");
        // The refunds of a purchase would refund nothing once it is void, so
        if (
          transaction.kind === "expense" &&
          (await stores.finance.refundedMinor(transaction.id)) > 0n
        ) {
          throw new FinanceConflictError("purchase-has-refunds");
        }
        const { entry } = await ledgerOperations.reverseEntry(
          stores.ledger,
          transaction.journalEntryId,
          {
            entryDate: date,
            description: `Void: ${transaction.kind.replace("_", " ")}`,
            idempotencyKey: key,
          },
        );
        await stores.finance.linkVoid(transaction.id, entry.id);
        return {
          value: await mustFindTransaction(stores.finance, transaction.id),
          replayed: false,
        };
      });
    },

    async updateTransactionDetails(
      owner: AuthorizedOwner,
      id: string,
      input: { readonly payee: unknown; readonly note: unknown },
    ): Promise<void> {
      const issues = new IssueCollector();
      const payee =
        issues.capture("payee", () => parsePayee(input.payee)) ?? null;
      const note = issues.capture("note", () => parseNote(input.note)) ?? null;
      issues.throwIfAny();
      return inTransaction(owner, async ({ finance }) => {
        const transaction = await mustFindTransaction(finance, id, true);
        if (
          isTwoSided(transaction.kind) ||
          transaction.kind === "opening_balance"
        ) {
          if (payee !== null)
            throw fieldError(
              "payee",
              "Transfers, card payments and opening balances have no payee",
            );
        }
        await finance.updateTransactionDetails(transaction.id, { payee, note });
      });
    },

    async getTransaction(
      owner: AuthorizedOwner,
      id: string,
    ): Promise<TransactionRecord> {
      return inTransaction(owner, ({ finance }) =>
        mustFindTransaction(finance, id),
      );
    },

    async listTransactions(
      owner: AuthorizedOwner,
      filters: Partial<TransactionFilters> = {},
    ): Promise<TransactionRecord[]> {
      return inTransaction(owner, ({ finance }) =>
        finance.listTransactions({
          includeVoided: true,
          limit: 200,
          ...filters,
        }),
      );
    },

    async listRefundablePurchases(
      owner: AuthorizedOwner,
    ): Promise<RefundablePurchase[]> {
      return inTransaction(owner, async ({ finance }) => {
        const rows = await finance.listRefundablePurchases();
        return rows
          .map(({ purchase, refundedMinor }) => {
            const refunded = Money.ofMinor(
              refundedMinor,
              purchase.amount.currency,
            );
            return {
              purchase,
              refunded,
              remaining: remainingRefundable(purchase.amount, refunded),
            };
          })
          .filter(({ remaining }) => !remaining.isZero());
      });
    },

    async getPurchaseRefunds(
      owner: AuthorizedOwner,
      id: string,
    ): Promise<PurchaseRefunds | null> {
      return inTransaction(owner, async ({ finance }) => {
        const purchase = await mustFindTransaction(finance, id);
        if (purchase.kind !== "expense" || purchase.sourceAccountId === null)
          return null;
        const paidBy = await finance.findAccount(purchase.sourceAccountId);
        if (!paidBy || ACCOUNT_LEDGER_KIND[paidBy.type] !== "liability")
          return null;
        const refunded = Money.ofMinor(
          await finance.refundedMinor(purchase.id),
          purchase.amount.currency,
        );
        return {
          purchase,
          refunded,
          remaining: remainingRefundable(purchase.amount, refunded),
          refunds: await finance.listRefunds(purchase.id),
        };
      });
    },
  };
}

export type FinanceService = ReturnType<typeof createFinanceService>;
