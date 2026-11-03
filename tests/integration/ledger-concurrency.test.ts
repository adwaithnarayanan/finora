import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";

import { EntryAlreadyReversedError, type LedgerAccount } from "@/domain/ledger";
import type { AuthorizedOwner } from "@/server/auth/types";
import { createPrismaClient } from "@/server/db/client";

import {
  adminClient,
  appClient,
  deleteOwners,
  seedOwner,
  type SeededOwner,
} from "./support/db";
import { asOwner, authorize, ledgerFor, line, newKey } from "./support/ledger";

const PARALLEL = 8;
const prisma = createPrismaClient(inject("local").appDatabaseUrl, PARALLEL);
const ledger = ledgerFor(prisma);
let admin: pg.Client;
let seeded: SeededOwner;
let owner: AuthorizedOwner;
let cash: LedgerAccount;
let income: LedgerAccount;

const today = "2026-10-25";
const times = <T>(n: number, fn: (i: number) => Promise<T>) =>
  Promise.allSettled(Array.from({ length: n }, (_, i) => fn(i)));

async function net(account: LedgerAccount) {
  return (await ledger.getAccountBalance(owner, account.id)).balance.net.minor;
}

beforeAll(async () => {
  admin = await adminClient();
  seeded = await seedOwner(admin);
  owner = await authorize(prisma, seeded.subject);
  cash = await ledger.createAccount(owner, {
    name: "Cash",
    kind: "asset",
    currency: "INR",
  });
  income = await ledger.createAccount(owner, {
    name: "Income",
    kind: "income",
    currency: "INR",
  });
});

afterAll(async () => {
  await deleteOwners(admin, seeded ? [seeded.ownerId] : []);
  await admin.end();
  await prisma.$disconnect();
});

describe("concurrent duplicates", () => {
  it("posts once when the same idempotent request races itself", async () => {
    const before = await net(cash);
    const key = newKey("race");
    const results = await times(PARALLEL, () =>
      ledger.postEntry(owner, {
        entryDate: today,
        description: "Raced",
        idempotencyKey: key,
        lines: [line(cash.id, "debit", "10"), line(income.id, "credit", "10")],
      }),
    );
    const fulfilled = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    expect(fulfilled).toHaveLength(PARALLEL);
    expect(new Set(fulfilled.map((r) => r.entry.id)).size).toBe(1);
    expect(fulfilled.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await net(cash)) - before).toBe(1_000n);
  });

  it("posts a draft once when posting races itself", async () => {
    const before = await net(cash);
    const { entry: draft } = await ledger.createDraft(owner, {
      entryDate: today,
      description: "Draft",
      lines: [line(cash.id, "debit", "3"), line(income.id, "credit", "3")],
    });
    const results = await times(PARALLEL, () =>
      ledger.postDraft(owner, draft.id),
    );
    const fulfilled = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    expect(fulfilled).toHaveLength(PARALLEL);
    expect(fulfilled.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await net(cash)) - before).toBe(300n);
  });

  it("reverses once when different reversal requests race", async () => {
    const { entry } = await ledger.postEntry(owner, {
      entryDate: today,
      description: "To reverse",
      idempotencyKey: newKey(),
      lines: [line(cash.id, "debit", "7"), line(income.id, "credit", "7")],
    });
    const before = await net(cash);
    const results = await times(PARALLEL, (i) =>
      ledger.reverseEntry(owner, entry.id, {
        entryDate: today,
        description: `Reverse ${i}`,
        idempotencyKey: newKey(`rev${i}`),
      }),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason] : [],
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(PARALLEL - 1);
    for (const reason of rejected)
      expect(reason).toBeInstanceOf(EntryAlreadyReversedError);
    expect((await net(cash)) - before).toBe(-700n);
  });

  it("returns the same reversal when one reversal request races itself", async () => {
    const { entry } = await ledger.postEntry(owner, {
      entryDate: today,
      description: "To reverse",
      idempotencyKey: newKey(),
      lines: [line(cash.id, "debit", "2"), line(income.id, "credit", "2")],
    });
    const key = newKey("same-rev");
    const results = await times(PARALLEL, () =>
      ledger.reverseEntry(owner, entry.id, {
        entryDate: today,
        description: "Reverse",
        idempotencyKey: key,
      }),
    );
    const fulfilled = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    expect(fulfilled).toHaveLength(PARALLEL);
    expect(new Set(fulfilled.map((r) => r.entry.id)).size).toBe(1);
    expect(fulfilled.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it("loses no effect when independent entries post concurrently", async () => {
    const before = await net(cash);
    const results = await times(PARALLEL, (i) =>
      ledger.postEntry(owner, {
        entryDate: today,
        description: `Independent ${i}`,
        idempotencyKey: newKey(`ind${i}`),
        lines: [
          line(cash.id, "debit", "1.01"),
          line(income.id, "credit", "1.01"),
        ],
      }),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await net(cash)) - before).toBe(BigInt(PARALLEL) * 101n);
  });
});

describe("interleaved transactions (deterministic)", () => {
  let first: pg.Client;
  let second: pg.Client;

  beforeAll(async () => {
    first = await appClient();
    second = await appClient();
  });

  afterAll(async () => {
    await first.end();
    await second.end();
  });

  async function draftWithLines(lines: [string, "debit" | "credit", number][]) {
    return asOwner(first, seeded.ownerId, async () => {
      const { rows } = await first.query(
        `INSERT INTO finora.journal_entries (owner_id, entry_date, description)
         VALUES ($1, '2026-10-25', 'interleave') RETURNING id::text`,
        [seeded.ownerId],
      );
      for (const [i, [account, side, amount]] of lines.entries()) {
        await first.query(
          `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
           VALUES ($1, $2, $3, $4, 'INR', $5, $6)`,
          [seeded.ownerId, rows[0].id, i + 1, account, side, amount],
        );
      }
      return rows[0].id as string;
    });
  }

  async function waitUntilBlocked(client: pg.Client) {
    const pid = (client as unknown as { processID: number }).processID;
    for (let i = 0; i < 100; i++) {
      const { rows } = await admin.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
        [pid],
      );
      if (rows[0]?.wait_event_type === "Lock") return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("second transaction never blocked");
  }

  const begin = async (client: pg.Client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('finora.owner_id', $1, true)", [
      seeded.ownerId,
    ]);
  };

  it("a line added while a post is in flight waits, then is refused", async () => {
    const id = await draftWithLines([
      [cash.id, "debit", 500],
      [income.id, "credit", 500],
    ]);
    await begin(first);
    await first.query(
      "UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1",
      [id],
    );

    await begin(second);
    const insert = second.query(
      `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
       VALUES ($1, $2, 3, $3, 'INR', 'debit', 1)`,
      [seeded.ownerId, id, cash.id],
    );
    const settled = insert.then(
      () => "inserted",
      (error: Error) => error.message,
    );
    await waitUntilBlocked(second);
    await first.query("COMMIT");
    expect(await settled).toMatch(
      /lines of a posted journal entry cannot be added/,
    );
    await second.query("ROLLBACK");
  });

  it("a post that waits for a concurrent line change sees that change at COMMIT", async () => {
    const id = await draftWithLines([
      [cash.id, "debit", 500],
      [income.id, "credit", 500],
    ]);
    await begin(first);
    await first.query(
      `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
       VALUES ($1, $2, 3, $3, 'INR', 'debit', 1)`,
      [seeded.ownerId, id, cash.id],
    );

    await begin(second);
    const posting = second.query(
      "UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1",
      [id],
    );
    await waitUntilBlocked(second);
    await first.query("COMMIT");
    await posting;
    await expect(second.query("COMMIT")).rejects.toThrow(/unbalanced/);
    const { rows } = await admin.query(
      "SELECT status FROM finora.journal_entries WHERE id = $1",
      [id],
    );
    expect(rows[0].status).toBe("draft");
  });
});
