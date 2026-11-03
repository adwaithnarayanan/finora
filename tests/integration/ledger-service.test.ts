import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EntryAlreadyReversedError,
  EntryNotDraftError,
  EntryNotReversibleError,
  type JournalEntry,
  LedgerValidationError,
  type LedgerAccount,
  offsetsExactly,
} from "@/domain/ledger";
import type { AuthorizedOwner } from "@/server/auth/types";
import {
  DuplicateLedgerAccountError,
  IdempotencyConflictError,
  LedgerIntegrityError,
  LedgerNotFoundError,
} from "@/server/ledger/errors";

import {
  adminClient,
  appPrisma,
  deleteOwners,
  seedOwner,
  type SeededOwner,
} from "./support/db";
import { authorize, ledgerFor, line, newKey } from "./support/ledger";

const prisma = appPrisma();
const ledger = ledgerFor(prisma);
let admin: pg.Client;
let seeded: SeededOwner;
let owner: AuthorizedOwner;
let cash: LedgerAccount;
let bank: LedgerAccount;
let salary: LedgerAccount;
let groceries: LedgerAccount;
let card: LedgerAccount;
let usdCash: LedgerAccount;
let usdIncome: LedgerAccount;

const today = "2026-10-25";

async function counts() {
  const { rows } = await admin.query(
    `SELECT (SELECT count(*) FROM finora.journal_entries WHERE owner_id = $1)::int AS entries,
            (SELECT count(*) FROM finora.journal_lines WHERE owner_id = $1)::int AS lines`,
    [seeded.ownerId],
  );
  return rows[0] as { entries: number; lines: number };
}

async function balance(account: LedgerAccount) {
  const { balance } = await ledger.getAccountBalance(owner, account.id);
  return balance.net.minor;
}

async function post(
  lines: ReturnType<typeof line>[],
  description = "Test entry",
) {
  const { entry } = await ledger.postEntry(owner, {
    entryDate: today,
    description,
    idempotencyKey: newKey("post"),
    lines,
  });
  return entry;
}

beforeAll(async () => {
  admin = await adminClient();
  seeded = await seedOwner(admin);
  owner = await authorize(prisma, seeded.subject);
  const create = (name: string, kind: string, currency = "INR") =>
    ledger.createAccount(owner, { name, kind, currency });
  cash = await create("Cash", "asset");
  bank = await create("Bank", "asset");
  salary = await create("Salary", "income");
  groceries = await create("Groceries", "expense");
  card = await create("Credit card", "liability");
  usdCash = await create("USD cash", "asset", "USD");
  usdIncome = await create("USD income", "income", "USD");
});

afterAll(async () => {
  await deleteOwners(admin, seeded ? [seeded.ownerId] : []);
  await admin.end();
  await prisma.$disconnect();
});

describe("ledger accounts", () => {
  it("creates owner-scoped accounts with an explicit currency", async () => {
    expect(cash).toMatchObject({
      name: "Cash",
      kind: "asset",
      currency: { code: "INR", exponent: 2 },
    });
    expect(usdCash.currency).toEqual({ code: "USD", exponent: 2 });
    const { rows } = await admin.query(
      "SELECT owner_id::text FROM finora.ledger_accounts WHERE id = $1",
      [cash.id],
    );
    expect(rows[0].owner_id).toBe(seeded.ownerId);
  });

  it("rejects duplicate names, unknown currencies and kinds", async () => {
    await expect(
      ledger.createAccount(owner, {
        name: "Cash",
        kind: "asset",
        currency: "INR",
      }),
    ).rejects.toThrow(DuplicateLedgerAccountError);
    await expect(
      ledger.createAccount(owner, {
        name: "Gold",
        kind: "asset",
        currency: "XAU",
      }),
    ).rejects.toThrow(/Unsupported currency/);
    await expect(
      ledger.createAccount(owner, {
        name: "Odd",
        kind: "contra",
        currency: "INR",
      }),
    ).rejects.toThrow(/Account kind/);
  });
});

describe("posting", () => {
  it("posts a balanced entry atomically and reflects it in balances", async () => {
    const before = await balance(bank);
    const entry = await post([
      line(bank.id, "debit", "50000.00"),
      line(salary.id, "credit", "50000"),
    ]);
    expect(entry.status).toBe("posted");
    expect(entry.postedAt).toBeInstanceOf(Date);
    expect(entry.postedAt!.getTime()).toBeGreaterThanOrEqual(
      entry.createdAt.getTime(),
    );
    expect(entry.lines.map((l) => [l.side, l.amount.minor])).toEqual([
      ["debit", 5_000_000n],
      ["credit", 5_000_000n],
    ]);
    expect((await balance(bank)) - before).toBe(5_000_000n);
    const { balance: income } = await ledger.getAccountBalance(
      owner,
      salary.id,
    );
    expect(income.normal.isPositive()).toBe(true);
  });

  it("posts multi-line, multi-currency entries that balance per currency", async () => {
    const entry = await post([
      line(groceries.id, "debit", "1200.50"),
      line(cash.id, "debit", "300"),
      line(card.id, "credit", "1500.50"),
      line(usdCash.id, "debit", "10.25", "USD"),
      line(usdIncome.id, "credit", "10.25", "USD"),
    ]);
    expect(entry.lines).toHaveLength(5);
  });

  it("rejects an unbalanced entry and writes nothing", async () => {
    const before = await counts();
    const attempt = ledger.postEntry(owner, {
      entryDate: today,
      description: "Unbalanced",
      idempotencyKey: newKey(),
      lines: [
        line(bank.id, "debit", "100"),
        line(salary.id, "credit", "99.99"),
      ],
    });
    await expect(attempt).rejects.toThrow(LedgerValidationError);
    await expect(attempt).rejects.toMatchObject({
      issues: [
        {
          code: "unbalanced",
          currency: "INR",
          debits: "100.00",
          credits: "99.99",
        },
      ],
    });
    expect(await counts()).toEqual(before);
  });

  it("rejects totals that balance overall but not per currency", async () => {
    await expect(
      post([
        line(bank.id, "debit", "10"),
        line(usdIncome.id, "credit", "10", "USD"),
      ]),
    ).rejects.toMatchObject({
      issues: [
        { code: "unbalanced", currency: "INR" },
        { code: "unbalanced", currency: "USD" },
      ],
    });
  });

  it.each([
    ["zero", "0.00", "non-positive-amount"],
    ["negative", "-5", "non-positive-amount"],
    ["excess precision", "1.005", "invalid-amount"],
    ["float syntax", "1e3", "invalid-amount"],
  ])("rejects a %s amount", async (_label, amount, code) => {
    await expect(
      post([line(bank.id, "debit", amount), line(salary.id, "credit", amount)]),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it("rejects a currency that does not match the account", async () => {
    await expect(
      post([
        line(bank.id, "debit", "1", "USD"),
        line(salary.id, "credit", "1"),
      ]),
    ).rejects.toMatchObject({
      issues: [
        { code: "currency-mismatch", line: 0, expected: "INR", actual: "USD" },
      ],
    });
  });

  it("rejects unknown and malformed account ids alike", async () => {
    await expect(
      post([
        line("00000000-0000-4000-8000-000000000000", "debit", "1"),
        line("not-a-uuid", "credit", "1"),
      ]),
    ).rejects.toMatchObject({
      issues: [
        { code: "unknown-account", line: 0 },
        { code: "unknown-account", line: 1 },
      ],
    });
  });

  it("rejects empty entries and invalid dates or descriptions", async () => {
    await expect(post([])).rejects.toMatchObject({
      issues: [{ code: "no-lines" }],
    });
    await expect(
      ledger.postEntry(owner, {
        entryDate: "2026-02-30",
        description: "x",
        idempotencyKey: newKey(),
        lines: [],
      }),
    ).rejects.toThrow(/calendar date/);
    await expect(
      ledger.postEntry(owner, {
        entryDate: today,
        description: "  ",
        idempotencyKey: newKey(),
        lines: [],
      }),
    ).rejects.toThrow(/Description/);
  });
});

describe("idempotency", () => {
  const request = (key: string, amount = "250") => ({
    entryDate: today,
    description: "Rent share",
    idempotencyKey: key,
    lines: [
      line(groceries.id, "debit", amount),
      line(cash.id, "credit", amount),
    ],
  });

  it("replays an identical retry without a second accounting effect", async () => {
    const key = newKey("retry");
    const before = await balance(cash);
    const first = await ledger.postEntry(owner, request(key));
    const second = await ledger.postEntry(owner, request(key, "250.00"));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(before - (await balance(cash))).toBe(25_000n);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM finora.journal_entries WHERE owner_id = $1 AND idempotency_key = $2",
      [seeded.ownerId, key],
    );
    expect(rows[0].n).toBe(1);
  });

  it("refuses a different request under a used key", async () => {
    const key = newKey("conflict");
    await ledger.postEntry(owner, request(key));
    await expect(ledger.postEntry(owner, request(key, "251"))).rejects.toThrow(
      IdempotencyConflictError,
    );
    await expect(
      ledger.createDraft(owner, { ...request(key), idempotencyKey: key }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("rejects malformed keys before touching the database", async () => {
    for (const key of [
      "",
      " spaced",
      "x".repeat(129),
      "semi;colon",
      "-leading",
    ]) {
      await expect(ledger.postEntry(owner, request(key))).rejects.toThrow(
        /Idempotency key/,
      );
    }
  });

  it("scopes keys to the owner (same key, different owners, no conflict)", async () => {
    const other = await seedOwner(admin);
    try {
      const otherOwner = await authorize(prisma, other.subject);
      const otherCash = await ledger.createAccount(otherOwner, {
        name: "Cash",
        kind: "asset",
        currency: "INR",
      });
      const otherIncome = await ledger.createAccount(otherOwner, {
        name: "Gifts",
        kind: "income",
        currency: "INR",
      });
      const key = newKey("shared");
      const mine = await ledger.postEntry(owner, request(key));
      const theirs = await ledger.postEntry(otherOwner, {
        ...request(key),
        lines: [
          line(otherCash.id, "debit", "250"),
          line(otherIncome.id, "credit", "250"),
        ],
      });
      expect(theirs.replayed).toBe(false);
      expect(theirs.entry.id).not.toBe(mine.entry.id);
    } finally {
      await deleteOwners(admin, [other.ownerId]);
    }
  });
});

describe("drafts", () => {
  it("does not affect balances until posted, then posts exactly once", async () => {
    const before = await balance(bank);
    const { entry: draft } = await ledger.createDraft(owner, {
      entryDate: today,
      description: "Pending transfer",
      lines: [line(cash.id, "debit", "75")],
    });
    expect(draft.status).toBe("draft");
    expect(draft.postedAt).toBeNull();
    expect(await ledger.validateDraft(owner, draft.id)).toEqual([
      { code: "unbalanced", currency: "INR", debits: "75.00", credits: "0.00" },
    ]);
    await expect(ledger.postDraft(owner, draft.id)).rejects.toThrow(
      LedgerValidationError,
    );

    await ledger.replaceDraftLines(owner, draft.id, [
      line(cash.id, "debit", "75"),
      line(bank.id, "credit", "75"),
    ]);
    expect(await ledger.validateDraft(owner, draft.id)).toEqual([]);
    expect(await balance(bank)).toBe(before);

    const posted = await ledger.postDraft(owner, draft.id);
    expect(posted).toMatchObject({
      replayed: false,
      entry: { status: "posted" },
    });
    expect(before - (await balance(bank))).toBe(7_500n);

    const again = await ledger.postDraft(owner, draft.id);
    expect(again.replayed).toBe(true);
    expect(before - (await balance(bank))).toBe(7_500n);
  });

  it("cannot edit or re-validate a posted entry's lines", async () => {
    const entry = await post([
      line(cash.id, "debit", "1"),
      line(bank.id, "credit", "1"),
    ]);
    await expect(
      ledger.replaceDraftLines(owner, entry.id, [
        line(cash.id, "debit", "2"),
        line(bank.id, "credit", "2"),
      ]),
    ).rejects.toThrow(EntryNotDraftError);
    await expect(ledger.validateDraft(owner, entry.id)).rejects.toThrow(
      EntryNotDraftError,
    );
    expect(
      (await ledger.getEntry(owner, entry.id)).lines.map((l) => l.amount.minor),
    ).toEqual([100n, 100n]);
  });

  it("replays a draft created with a key", async () => {
    const key = newKey("draft");
    const input = {
      entryDate: today,
      description: "Draft",
      idempotencyKey: key,
      lines: [line(cash.id, "debit", "5")],
    };
    const first = await ledger.createDraft(owner, input);
    const second = await ledger.createDraft(owner, input);
    expect(second).toMatchObject({
      replayed: true,
      entry: { id: first.entry.id },
    });
  });
});

describe("atomicity", () => {
  it("rolls back every write when the operation fails part-way", async () => {
    const failing = ledgerFor(prisma, (store) => ({
      ...bindAll(store),
      markPosted: async () => {
        throw new Error("simulated crash after lines were written");
      },
    }));
    const before = await counts();
    await expect(
      failing.postEntry(owner, {
        entryDate: today,
        description: "Crash",
        idempotencyKey: newKey("crash"),
        lines: [line(cash.id, "debit", "9"), line(bank.id, "credit", "9")],
      }),
    ).rejects.toThrow("simulated crash");
    expect(await counts()).toEqual(before);
  });

  it("lets the database veto an unbalanced post even if domain checks are skipped", async () => {
    const buggy = ledgerFor(prisma, (store) => ({
      ...bindAll(store),
      replaceLines: (id, lines) => store.replaceLines(id, lines.slice(0, -1)),
    }));
    const before = await counts();
    const attempt = buggy.postEntry(owner, {
      entryDate: today,
      description: "Buggy",
      idempotencyKey: newKey("buggy"),
      lines: [line(cash.id, "debit", "9"), line(bank.id, "credit", "9")],
    });
    await expect(attempt).rejects.toThrow(LedgerIntegrityError);
    await expect(attempt).rejects.toMatchObject({
      reason: "posted journal entry is unbalanced",
    });
    expect(await counts()).toEqual(before);
  });
});

describe("reversal and correction", () => {
  let original: JournalEntry;

  beforeAll(async () => {
    original = await post(
      [line(groceries.id, "debit", "640"), line(card.id, "credit", "640")],
      "Groceries",
    );
  });

  it("reverses through a new, linked, posted entry and offsets the effect", async () => {
    const before = {
      groceries: await balance(groceries),
      card: await balance(card),
    };
    const key = newKey("reverse");
    const { entry: reversal, replayed } = await ledger.reverseEntry(
      owner,
      original.id,
      {
        entryDate: "2026-10-26",
        description: "Reverse groceries",
        idempotencyKey: key,
      },
    );
    expect(replayed).toBe(false);
    expect(reversal).toMatchObject({
      status: "posted",
      reversesEntryId: original.id,
    });
    expect(offsetsExactly(original.lines, reversal.lines)).toBe(true);

    const refreshed = await ledger.getEntry(owner, original.id);
    expect(refreshed.reversedByEntryId).toBe(reversal.id);
    expect(refreshed.lines).toEqual(original.lines);
    expect(refreshed.postedAt).toEqual(original.postedAt);

    expect((await balance(groceries)) - before.groceries).toBe(-64_000n);
    expect((await balance(card)) - before.card).toBe(64_000n);

    const retry = await ledger.reverseEntry(owner, original.id, {
      entryDate: "2026-10-26",
      description: "Reverse groceries",
      idempotencyKey: key,
    });
    expect(retry).toMatchObject({ replayed: true, entry: { id: reversal.id } });

    await expect(
      ledger.reverseEntry(owner, original.id, {
        entryDate: today,
        description: "Again",
        idempotencyKey: newKey(),
      }),
    ).rejects.toThrow(EntryAlreadyReversedError);
    await expect(
      ledger.reverseEntry(owner, reversal.id, {
        entryDate: today,
        description: "Undo",
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ reason: "is-reversal" });
  });

  it("does not reverse drafts", async () => {
    const { entry: draft } = await ledger.createDraft(owner, {
      entryDate: today,
      description: "Draft",
      lines: [line(cash.id, "debit", "1"), line(bank.id, "credit", "1")],
    });
    await expect(
      ledger.reverseEntry(owner, draft.id, {
        entryDate: today,
        description: "No",
        idempotencyKey: newKey(),
      }),
    ).rejects.toThrow(EntryNotReversibleError);
  });

  it("corrects atomically: reversal plus linked replacement", async () => {
    const wrong = await post(
      [line(groceries.id, "debit", "100"), line(cash.id, "credit", "100")],
      "Typo",
    );
    const before = await balance(groceries);
    const key = newKey("correct");
    const input = {
      entryDate: today,
      description: "Correct typo",
      idempotencyKey: key,
      replacement: {
        entryDate: today,
        description: "Groceries (corrected)",
        lines: [
          line(groceries.id, "debit", "10"),
          line(cash.id, "credit", "10"),
        ],
      },
    };
    const result = await ledger.correctEntry(owner, wrong.id, input);
    expect(result.replayed).toBe(false);
    expect(result.reversal.reversesEntryId).toBe(wrong.id);
    expect(result.replacement.replacesEntryId).toBe(wrong.id);
    expect((await balance(groceries)) - before).toBe(-9_000n);

    const retry = await ledger.correctEntry(owner, wrong.id, input);
    expect(retry).toMatchObject({
      replayed: true,
      reversal: { id: result.reversal.id },
      replacement: { id: result.replacement.id },
    });
    expect((await balance(groceries)) - before).toBe(-9_000n);
  });

  it("leaves nothing behind when the replacement is invalid", async () => {
    const target = await post([
      line(groceries.id, "debit", "3"),
      line(cash.id, "credit", "3"),
    ]);
    const before = await counts();
    await expect(
      ledger.correctEntry(owner, target.id, {
        entryDate: today,
        description: "Bad correction",
        idempotencyKey: newKey(),
        replacement: {
          entryDate: today,
          description: "Bad",
          lines: [line(groceries.id, "debit", "3")],
        },
      }),
    ).rejects.toThrow(LedgerValidationError);
    expect(await counts()).toEqual(before);
    expect(
      (await ledger.getEntry(owner, target.id)).reversedByEntryId,
    ).toBeNull();
  });
});

describe("balances", () => {
  it("are exactly reconstructable from posted lines", async () => {
    for (const account of [
      cash,
      bank,
      salary,
      groceries,
      card,
      usdCash,
      usdIncome,
    ]) {
      const { rows } = await admin.query(
        `SELECT coalesce(sum(CASE l.side WHEN 'debit' THEN l.amount_minor ELSE -l.amount_minor END), 0)::text AS net
           FROM finora.journal_lines l JOIN finora.journal_entries e ON e.id = l.entry_id
          WHERE l.account_id = $1 AND e.status = 'posted'`,
        [account.id],
      );
      const { balance: computed } = await ledger.getAccountBalance(
        owner,
        account.id,
      );
      expect(computed.net.minor, account.name).toBe(BigInt(rows[0].net));
      expect(
        computed.debits.subtract(computed.credits).equals(computed.net),
      ).toBe(true);
    }
  });

  it("not found for unknown accounts and entries", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(ledger.getAccountBalance(owner, missing)).rejects.toThrow(
      LedgerNotFoundError,
    );
    await expect(ledger.getEntry(owner, missing)).rejects.toThrow(
      LedgerNotFoundError,
    );
    await expect(ledger.getEntry(owner, "garbage")).rejects.toThrow(
      /canonical lowercase UUID/,
    );
  });
});

function bindAll<T extends object>(store: T): T {
  const proto = Object.getPrototypeOf(store) as object;
  const out = {} as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    const value = (store as Record<string, unknown>)[name];
    if (typeof value === "function") out[name] = value.bind(store);
  }
  return out as T;
}
