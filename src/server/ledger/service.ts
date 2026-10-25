import { createHash } from "node:crypto";

import {
  ACCOUNT_KINDS,
  type AccountBalance,
  type AccountKind,
  type IdempotencyKey,
  type IdempotentRequest,
  InvalidLedgerInputError,
  type JournalEntry,
  type JournalEntryId,
  type JournalLineInput,
  type LedgerAccount,
  type LedgerDate,
  type LedgerIssue,
  assertCanPost,
  assertDraft,
  assertPostable,
  balanceFromTotals,
  buildLines,
  canonicalRequest,
  parseAccountName,
  parseDescription,
  parseIdempotencyKey,
  parseJournalEntryId,
  parseLedgerAccountId,
  parseLedgerDate,
  planReversal,
  postingIssues,
} from "@/domain/ledger";
import { Money } from "@/domain/money";
import type { AuthorizedOwner } from "@/server/auth/types";

import { translateDatabaseError } from "./database-errors";
import {
  DuplicateLedgerAccountError,
  IdempotencyConflictError,
  LedgerIntegrityError,
  LedgerNotFoundError,
} from "./errors";
import type { LedgerStore } from "./store";

/**
 * Runs `work` in one database transaction scoped (RLS) to `owner`. Everything
 * `work` writes commits together or not at all.
 */
export type LedgerRunner = <T>(
  owner: AuthorizedOwner,
  work: (store: LedgerStore) => Promise<T>,
) => Promise<T>;

export interface EntryInput {
  readonly entryDate: string;
  readonly description: string;
  readonly lines: readonly JournalLineInput[];
}

export interface CorrectionInput {
  readonly entryDate: string;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly replacement: EntryInput;
}

export interface EntryResult {
  readonly entry: JournalEntry;
  /** True when an earlier identical request already did the work. */
  readonly replayed: boolean;
}

export interface CorrectionResult {
  readonly reversal: JournalEntry;
  readonly replacement: JournalEntry;
  readonly replayed: boolean;
}

const fingerprint = (request: IdempotentRequest) =>
  createHash("sha256").update(canonicalRequest(request)).digest("hex");

function parseKind(value: unknown): AccountKind {
  if (!(ACCOUNT_KINDS as readonly unknown[]).includes(value)) {
    throw new InvalidLedgerInputError(`Account kind must be one of ${ACCOUNT_KINDS.join(", ")}`);
  }
  return value as AccountKind;
}

function accountIds(inputs: readonly JournalLineInput[]) {
  // Malformed ids are left out here and reported by buildLines as unknown accounts.
  const ids = new Set<string>();
  for (const input of inputs) {
    try {
      ids.add(parseLedgerAccountId(input.accountId));
    } catch {
      // reported later
    }
  }
  return [...ids].map((id) => parseLedgerAccountId(id));
}

async function lookupAccounts(store: LedgerStore, inputs: readonly JournalLineInput[]) {
  const accounts = await store.findAccounts(accountIds(inputs));
  return new Map(accounts.map((a) => [a.id as string, a]));
}

interface ParsedEntry {
  readonly entryDate: LedgerDate;
  readonly description: string;
  readonly inputs: readonly JournalLineInput[];
}

function parseEntryInput(input: EntryInput): ParsedEntry {
  if (!Array.isArray(input.lines)) throw new InvalidLedgerInputError("Lines must be an array");
  return {
    entryDate: parseLedgerDate(input.entryDate),
    description: parseDescription(input.description),
    inputs: input.lines,
  };
}

async function mustFind(store: LedgerStore, id: JournalEntryId): Promise<JournalEntry> {
  const entry = await store.findEntry(id);
  if (!entry) throw new LedgerNotFoundError("entry");
  return entry;
}

/**
 * Returns the entry an earlier request created with `key`, or null if the key
 * is unused. A key reused for a different request is a conflict.
 */
async function replayed(
  store: LedgerStore,
  key: IdempotencyKey,
  expectedFingerprint: string,
): Promise<JournalEntry | null> {
  const existing = await store.findByIdempotencyKey(key);
  if (!existing) return null;
  if (existing.fingerprint !== expectedFingerprint) throw new IdempotencyConflictError();
  return mustFind(store, existing.id);
}

/**
 * Runs a whole owner-scoped transaction and converts a database refusal into
 * a LedgerIntegrityError (see database-errors.ts). Every service that commits
 * ledger writes, including ones composed with ledgerOperations, goes through it.
 */
export async function runTranslated<T>(transaction: () => Promise<T>): Promise<T> {
  try {
    return await transaction();
  } catch (error) {
    translateDatabaseError(error);
  }
}

/** Creates the entry and its lines, then posts it, in the current transaction. */
async function insertPosted(
  store: LedgerStore,
  entry: Parameters<LedgerStore["insertDraft"]>[0],
  lines: Parameters<LedgerStore["replaceLines"]>[1],
): Promise<JournalEntryId | null> {
  const id = await store.insertDraft(entry);
  if (id === null) return null;
  await store.replaceLines(id, lines);
  if (!(await store.markPosted(id))) throw new LedgerIntegrityError("entry was not a draft");
  return id;
}

/**
 * Ledger operations that run inside a caller's owner-scoped transaction, so
 * other server services (src/server/finance) can commit their business
 * records and the journal entries in one database transaction. They never
 * open or commit a transaction themselves: callers run them with a store
 * bound to an owner scope, inside runTranslated(). Same rules and idempotency
 * as the service methods below, which delegate here.
 */
export const ledgerOperations = {
  async createAccount(
    store: LedgerStore,
    input: { readonly name: string; readonly kind: string; readonly currency: string },
  ): Promise<LedgerAccount> {
    const name = parseAccountName(input.name);
    const kind = parseKind(input.kind);
    const currency = typeof input.currency === "string" ? await store.findCurrency(input.currency) : null;
    if (!currency) throw new InvalidLedgerInputError("Unsupported currency");
    const account = await store.insertAccount({ name, kind, currency });
    if (!account) throw new DuplicateLedgerAccountError();
    return account;
  },

  /**
   * Creates and posts a balanced entry in one step. The idempotency key makes
   * retries safe: the same request returns the original entry, a different
   * request with the same key is rejected.
   */
  async postEntry(store: LedgerStore, input: EntryInput & { readonly idempotencyKey: string }): Promise<EntryResult> {
    const parsed = parseEntryInput(input);
    const key = parseIdempotencyKey(input.idempotencyKey);
    const accounts = await lookupAccounts(store, parsed.inputs);
    const lines = buildLines(parsed.inputs, accounts);
    assertPostable(lines, accounts);
    const idempotency = {
      key,
      fingerprint: fingerprint({ kind: "post-entry", entryDate: parsed.entryDate, description: parsed.description, lines }),
    };
    const id = await insertPosted(
      store,
      { entryDate: parsed.entryDate, description: parsed.description, idempotency },
      lines,
    );
    if (id === null) {
      return { entry: (await replayed(store, key, idempotency.fingerprint))!, replayed: true };
    }
    return { entry: await mustFind(store, id), replayed: false };
  },

  async getEntry(store: LedgerStore, entryId: string): Promise<JournalEntry> {
    return mustFind(store, parseJournalEntryId(entryId));
  },

  /** Balance reconstructed from posted lines only. */
  async accountBalance(
    store: LedgerStore,
    accountId: string,
  ): Promise<{ account: LedgerAccount; balance: AccountBalance }> {
    const id = parseLedgerAccountId(accountId);
    const [account] = await store.findAccounts([id]);
    if (!account) throw new LedgerNotFoundError("account");
    const totals = await store.postedTotals(id);
    return {
      account,
      balance: balanceFromTotals(
        account,
        Money.ofMinor(totals.debits, account.currency),
        Money.ofMinor(totals.credits, account.currency),
      ),
    };
  },

  /**
   * Posts a new entry that exactly cancels a posted entry, linked to it. The
   * original is untouched. Retrying with the same key returns the same
   * reversal; any other attempt on a reversed entry fails with
   * EntryAlreadyReversedError.
   */
  async reverseEntry(
    store: LedgerStore,
    entryId: string,
    input: { readonly entryDate: string; readonly description: string; readonly idempotencyKey: string },
  ): Promise<EntryResult> {
    const id = parseJournalEntryId(entryId);
    const entryDate = parseLedgerDate(input.entryDate);
    const description = parseDescription(input.description);
    const key = parseIdempotencyKey(input.idempotencyKey);
    const idempotency = {
      key,
      fingerprint: fingerprint({ kind: "reverse-entry", entryId: id, entryDate, description }),
    };
    const original = await store.lockEntry(id);
    if (!original) throw new LedgerNotFoundError("entry");
    const previous = await replayed(store, key, idempotency.fingerprint);
    if (previous) return { entry: previous, replayed: true };

    const lines = planReversal(original);
    const reversalId = await insertPosted(store, { entryDate, description, idempotency, reversesEntryId: id }, lines);
    // Null: the key was taken concurrently by a different request.
    if (reversalId === null) throw new IdempotencyConflictError();
    return { entry: await mustFind(store, reversalId), replayed: false };
  },

  /**
   * Reverses a posted entry and posts its replacement in one transaction, so
   * there is never a moment with only one of the two. The replacement links
   * to the original via `replacesEntryId`.
   */
  async correctEntry(store: LedgerStore, entryId: string, input: CorrectionInput): Promise<CorrectionResult> {
    const id = parseJournalEntryId(entryId);
    const entryDate = parseLedgerDate(input.entryDate);
    const description = parseDescription(input.description);
    const key = parseIdempotencyKey(input.idempotencyKey);
    const replacementInput = parseEntryInput(input.replacement);
    const original = await store.lockEntry(id);
    if (!original) throw new LedgerNotFoundError("entry");

    const accounts = await lookupAccounts(store, replacementInput.inputs);
    const replacementLines = buildLines(replacementInput.inputs, accounts);
    assertPostable(replacementLines, accounts);
    const idempotency = {
      key,
      fingerprint: fingerprint({
        kind: "correct-entry",
        entryId: id,
        entryDate,
        description,
        replacement: {
          entryDate: replacementInput.entryDate,
          description: replacementInput.description,
          lines: replacementLines,
        },
      }),
    };

    const previous = await replayed(store, key, idempotency.fingerprint);
    if (previous) {
      const refreshed = await mustFind(store, id);
      return { reversal: previous, replacement: await mustFind(store, refreshed.replacedByEntryId!), replayed: true };
    }

    const reversalLines = planReversal(original);
    const reversalId = await insertPosted(
      store,
      { entryDate, description, idempotency, reversesEntryId: id },
      reversalLines,
    );
    if (reversalId === null) throw new IdempotencyConflictError();
    const replacementId = await insertPosted(
      store,
      {
        entryDate: replacementInput.entryDate,
        description: replacementInput.description,
        idempotency: null,
        replacesEntryId: id,
      },
      replacementLines,
    );
    if (replacementId === null) throw new LedgerIntegrityError("replacement was not created");
    return {
      reversal: await mustFind(store, reversalId),
      replacement: await mustFind(store, replacementId),
      replayed: false,
    };
  },
};

/**
 * The ledger's application service. Every method takes an `AuthorizedOwner`
 * (from `requireOwner()`), never an owner id, and does all of its work in one
 * owner-scoped transaction. Domain rules run first for precise errors; the
 * database re-checks the invariants at COMMIT regardless.
 */
export function createLedgerService(run: LedgerRunner) {
  const inTransaction = <T>(owner: AuthorizedOwner, work: (store: LedgerStore) => Promise<T>): Promise<T> =>
    runTranslated(() => run(owner, work));

  return {
    async createAccount(
      owner: AuthorizedOwner,
      input: { readonly name: string; readonly kind: string; readonly currency: string },
    ): Promise<LedgerAccount> {
      return inTransaction(owner, (store) => ledgerOperations.createAccount(store, input));
    },

    /** Creates a draft (balance not required). With a key, retries return the same draft. */
    async createDraft(
      owner: AuthorizedOwner,
      input: EntryInput & { readonly idempotencyKey?: string },
    ): Promise<EntryResult> {
      const parsed = parseEntryInput(input);
      const key = input.idempotencyKey === undefined ? null : parseIdempotencyKey(input.idempotencyKey);
      return inTransaction(owner, async (store) => {
        const lines = buildLines(parsed.inputs, await lookupAccounts(store, parsed.inputs));
        const request = { kind: "create-draft", entryDate: parsed.entryDate, description: parsed.description, lines } as const;
        const idempotency = key === null ? null : { key, fingerprint: fingerprint(request) };
        const id = await store.insertDraft({ entryDate: parsed.entryDate, description: parsed.description, idempotency });
        if (id === null) {
          // Only possible with a key: it was used before.
          return { entry: (await replayed(store, idempotency!.key, idempotency!.fingerprint))!, replayed: true };
        }
        await store.replaceLines(id, lines);
        return { entry: await mustFind(store, id), replayed: false };
      });
    },

    /** Replaces every line of a draft. Lines are checked individually, not for balance. */
    async replaceDraftLines(
      owner: AuthorizedOwner,
      entryId: string,
      inputs: readonly JournalLineInput[],
    ): Promise<JournalEntry> {
      const id = parseJournalEntryId(entryId);
      if (!Array.isArray(inputs)) throw new InvalidLedgerInputError("Lines must be an array");
      return inTransaction(owner, async (store) => {
        const draft = await store.lockEntry(id);
        if (!draft) throw new LedgerNotFoundError("entry");
        assertDraft(draft);
        const lines = buildLines(inputs, await lookupAccounts(store, inputs));
        await store.replaceLines(id, lines);
        return mustFind(store, id);
      });
    },

    /** Everything that would currently stop the draft from posting (empty if postable). */
    async validateDraft(owner: AuthorizedOwner, entryId: string): Promise<LedgerIssue[]> {
      const id = parseJournalEntryId(entryId);
      return inTransaction(owner, async (store) => {
        const draft = await mustFind(store, id);
        assertDraft(draft);
        const accounts = await store.findAccounts(draft.lines.map((l) => l.accountId));
        return postingIssues(draft.lines, new Map(accounts.map((a) => [a.id as string, a])));
      });
    },

    /**
     * Posts a draft atomically. Idempotent: posting an already-posted entry
     * returns it with `replayed: true` and changes nothing.
     */
    async postDraft(owner: AuthorizedOwner, entryId: string): Promise<EntryResult> {
      const id = parseJournalEntryId(entryId);
      return inTransaction(owner, async (store) => {
        // The lock serialises against concurrent posts and line edits.
        const draft = await store.lockEntry(id);
        if (!draft) throw new LedgerNotFoundError("entry");
        if (draft.status === "posted") return { entry: draft, replayed: true };
        const accounts = await store.findAccounts(draft.lines.map((l) => l.accountId));
        assertCanPost(draft, new Map(accounts.map((a) => [a.id as string, a])));
        if (!(await store.markPosted(id))) throw new LedgerIntegrityError("entry was not a draft");
        return { entry: await mustFind(store, id), replayed: false };
      });
    },

    /** Creates and posts a balanced entry in one step (idempotent; see ledgerOperations). */
    async postEntry(owner: AuthorizedOwner, input: EntryInput & { readonly idempotencyKey: string }): Promise<EntryResult> {
      return inTransaction(owner, (store) => ledgerOperations.postEntry(store, input));
    },

    async getEntry(owner: AuthorizedOwner, entryId: string): Promise<JournalEntry> {
      return inTransaction(owner, (store) => ledgerOperations.getEntry(store, entryId));
    },

    /** Balance reconstructed from posted lines only. */
    async getAccountBalance(
      owner: AuthorizedOwner,
      accountId: string,
    ): Promise<{ account: LedgerAccount; balance: AccountBalance }> {
      return inTransaction(owner, (store) => ledgerOperations.accountBalance(store, accountId));
    },

    /** Linked, exactly offsetting reversal (idempotent; see ledgerOperations). */
    async reverseEntry(
      owner: AuthorizedOwner,
      entryId: string,
      input: { readonly entryDate: string; readonly description: string; readonly idempotencyKey: string },
    ): Promise<EntryResult> {
      return inTransaction(owner, (store) => ledgerOperations.reverseEntry(store, entryId, input));
    },

    /** Reversal plus linked replacement in one transaction (idempotent; see ledgerOperations). */
    async correctEntry(owner: AuthorizedOwner, entryId: string, input: CorrectionInput): Promise<CorrectionResult> {
      return inTransaction(owner, (store) => ledgerOperations.correctEntry(store, entryId, input));
    },
  };
}

export type LedgerService = ReturnType<typeof createLedgerService>;
