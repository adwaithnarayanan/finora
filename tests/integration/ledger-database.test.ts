import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminClient,
  appClient,
  deleteOwners,
  seedOwner,
  type SeededOwner,
} from "./support/db";
import { asOwner } from "./support/ledger";

let admin: pg.Client;
let app: pg.Client;
let a: SeededOwner;
let b: SeededOwner;
const accounts: Record<string, string> = {};

async function createAccount(
  ownerId: string,
  name: string,
  kind: string,
  currency = "INR",
) {
  const { rows } = await admin.query(
    `INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code)
     VALUES ($1, $2, $3, $4) RETURNING id::text`,
    [ownerId, name, kind, currency],
  );
  return rows[0].id as string;
}

type Line = [
  account: string,
  side: "debit" | "credit",
  amountMinor: number | string,
  currency?: string,
];

async function insertEntry(
  client: pg.Client,
  ownerId: string,
  lines: Line[],
  extra: { reverses?: string; replaces?: string } = {},
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO finora.journal_entries (owner_id, entry_date, description, reverses_entry_id, replaces_entry_id)
     VALUES ($1, '2026-10-25', 'db test', $2, $3) RETURNING id::text`,
    [ownerId, extra.reverses ?? null, extra.replaces ?? null],
  );
  const entryId = rows[0].id as string;
  for (const [i, [account, side, amount, currency]] of lines.entries()) {
    await client.query(
      `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ownerId, entryId, i + 1, account, currency ?? "INR", side, amount],
    );
  }
  return entryId;
}

const post = (client: pg.Client, entryId: string) =>
  client.query(
    "UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1",
    [entryId],
  );

async function postedEntry(
  lines: Line[],
  extra?: { reverses?: string; replaces?: string },
) {
  return asOwner(app, a.ownerId, async () => {
    const id = await insertEntry(app, a.ownerId, lines, extra);
    await post(app, id);
    return id;
  });
}

async function entryCount(ownerId: string) {
  const { rows } = await admin.query(
    "SELECT count(*)::int AS n FROM finora.journal_entries WHERE owner_id = $1",
    [ownerId],
  );
  return rows[0].n as number;
}

async function lineSnapshot(entryId: string) {
  const { rows } = await admin.query(
    `SELECT e.status, e.posted_at, l.account_id::text, l.side, l.amount_minor::text
       FROM finora.journal_entries e JOIN finora.journal_lines l ON l.entry_id = e.id
      WHERE e.id = $1 ORDER BY l.line_no`,
    [entryId],
  );
  return rows;
}

beforeAll(async () => {
  admin = await adminClient();
  app = await appClient();
  a = await seedOwner(admin);
  b = await seedOwner(admin);
  accounts.cash = await createAccount(a.ownerId, "Cash", "asset");
  accounts.income = await createAccount(a.ownerId, "Income", "income");
  accounts.usd = await createAccount(a.ownerId, "USD", "asset", "USD");
  accounts.usdIncome = await createAccount(
    a.ownerId,
    "USD income",
    "income",
    "USD",
  );
  accounts.bCash = await createAccount(b.ownerId, "Cash", "asset");
  accounts.bIncome = await createAccount(b.ownerId, "Income", "income");
});

afterAll(async () => {
  await app?.end();
  await deleteOwners(
    admin,
    [a, b].filter(Boolean).map((o) => o.ownerId),
  );
  await admin?.end();
});

beforeEach(async () => {
  await app.query("ROLLBACK").catch(() => undefined);
});

describe("balancing (deferred constraint trigger)", () => {
  it("commits a balanced multi-line entry built across several statements", async () => {
    const id = await postedEntry([
      [accounts.cash!, "debit", 700],
      [accounts.cash!, "debit", 300],
      [accounts.income!, "credit", 1000],
    ]);
    const rows = await lineSnapshot(id);
    expect(rows).toHaveLength(3);
    expect(rows[0].status).toBe("posted");
    expect(rows[0].posted_at).toBeInstanceOf(Date);
  });

  it("refuses to commit an unbalanced posted entry, leaving nothing behind", async () => {
    const before = await entryCount(a.ownerId);
    await expect(
      postedEntry([
        [accounts.cash!, "debit", 1000],
        [accounts.income!, "credit", 999],
      ]),
    ).rejects.toThrow(/finora\.ledger: posted journal entry is unbalanced/);
    expect(await entryCount(a.ownerId)).toBe(before);
  });

  it("requires each currency to balance on its own", async () => {
    await expect(
      postedEntry([
        [accounts.cash!, "debit", 1000],
        [accounts.usdIncome!, "credit", 1000, "USD"],
      ]),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      postedEntry([
        [accounts.cash!, "debit", 1000],
        [accounts.income!, "credit", 1000],
        [accounts.usd!, "debit", 5, "USD"],
        [accounts.usdIncome!, "credit", 5, "USD"],
      ]),
    ).resolves.toBeTypeOf("string");
  });

  it("refuses to post an entry without lines", async () => {
    await expect(postedEntry([])).rejects.toThrow(/must have lines/);
  });

  it("still checks when the constraint is made IMMEDIATE", async () => {
    await expect(
      asOwner(app, a.ownerId, async () => {
        await app.query("SET CONSTRAINTS ALL IMMEDIATE");
        const id = await insertEntry(app, a.ownerId, [
          [accounts.cash!, "debit", 5],
        ]);
        await post(app, id);
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it("allows unbalanced drafts (they have no accounting effect)", async () => {
    const id = await asOwner(app, a.ownerId, () =>
      insertEntry(app, a.ownerId, [[accounts.cash!, "debit", 5]]),
    );
    expect((await lineSnapshot(id))[0].status).toBe("draft");
  });

  it("does not let entries be created already posted", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query(
          `INSERT INTO finora.journal_entries (owner_id, entry_date, description, status, posted_at)
           VALUES ($1, '2026-10-25', 'x', 'posted', now())`,
          [a.ownerId],
        ),
      ),
    ).rejects.toThrow(/created as drafts/);
  });
});

describe("row constraints", () => {
  it.each([
    ["zero", 0, /journal_lines_amount_positive/],
    ["negative", -1, /journal_lines_amount_positive/],
    ["beyond BIGINT", "9223372036854775808", /out of range/],
  ])("rejects a %s amount", async (_label, amount, error) => {
    await expect(
      asOwner(app, a.ownerId, () =>
        insertEntry(app, a.ownerId, [[accounts.cash!, "debit", amount]]),
      ),
    ).rejects.toThrow(error);
  });

  it("rejects a line whose currency differs from its account's", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        insertEntry(app, a.ownerId, [[accounts.cash!, "debit", 5, "USD"]]),
      ),
    ).rejects.toThrow(/journal_lines_account_fkey/);
  });

  it("rejects accounts in unknown currencies and invalid text", async () => {
    await expect(
      createAccount(a.ownerId, "Gold", "asset", "XAU"),
    ).rejects.toThrow(/currency_code_fkey/);
    await expect(createAccount(a.ownerId, " padded", "asset")).rejects.toThrow(
      /name_format/,
    );
    await expect(
      admin.query(
        "INSERT INTO finora.journal_entries (owner_id, entry_date, description, idempotency_key) VALUES ($1, '2026-10-25', 'x', 'k')",
        [a.ownerId],
      ),
    ).rejects.toThrow(/journal_entries_idempotency_pair/);
  });

  it("keeps currencies and account classification immutable", async () => {
    await expect(
      admin.query(
        "UPDATE finora.currencies SET exponent = 3 WHERE code = 'INR'",
      ),
    ).rejects.toThrow(/currencies are immutable/);
    await expect(
      admin.query(
        "UPDATE finora.ledger_accounts SET currency_code = 'USD' WHERE id = $1",
        [accounts.cash],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      admin.query(
        "UPDATE finora.ledger_accounts SET kind = 'expense' WHERE id = $1",
        [accounts.cash],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("assigns audit timestamps from the database clock", async () => {
    const { rows } = await asOwner(app, a.ownerId, () =>
      app.query(
        `INSERT INTO finora.journal_entries (owner_id, entry_date, description, created_at)
         VALUES ($1, '2026-10-25', 'backdated?', '2000-01-01') RETURNING created_at`,
        [a.ownerId],
      ),
    );
    expect(rows[0].created_at.getUTCFullYear()).toBeGreaterThan(2000);
  });
});

describe("immutability of posted history", () => {
  let entryId: string;
  let snapshot: Awaited<ReturnType<typeof lineSnapshot>>;

  beforeAll(async () => {
    entryId = await postedEntry([
      [accounts.cash!, "debit", 4200],
      [accounts.income!, "credit", 4200],
    ]);
    snapshot = await lineSnapshot(entryId);
  });

  const attempts: [string, string][] = [
    [
      "change the amount of a line",
      "UPDATE finora.journal_lines SET amount_minor = 1 WHERE entry_id = $1",
    ],
    [
      "flip a line's side",
      "UPDATE finora.journal_lines SET side = 'credit' WHERE entry_id = $1 AND side = 'debit'",
    ],
    ["delete a line", "DELETE FROM finora.journal_lines WHERE entry_id = $1"],
    [
      "add a line",
      `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
       SELECT owner_id, id, 99, (SELECT account_id FROM finora.journal_lines WHERE entry_id = $1 LIMIT 1), 'INR', 'debit', 1
         FROM finora.journal_entries WHERE id = $1`,
    ],
    [
      "un-post the entry",
      "UPDATE finora.journal_entries SET status = 'draft', posted_at = NULL WHERE id = $1",
    ],
    [
      "change its date",
      "UPDATE finora.journal_entries SET entry_date = '2020-01-01' WHERE id = $1",
    ],
    [
      "change its description",
      "UPDATE finora.journal_entries SET description = 'edited' WHERE id = $1",
    ],
    ["delete the entry", "DELETE FROM finora.journal_entries WHERE id = $1"],
  ];

  it.each(attempts)("the migration role cannot %s", async (_label, sql) => {
    await expect(admin.query(sql, [entryId])).rejects.toThrow(
      /finora\.ledger: /,
    );
    expect(await lineSnapshot(entryId)).toEqual(snapshot);
  });

  it.each(attempts)("the runtime role cannot %s", async (_label, sql) => {
    await expect(
      asOwner(app, a.ownerId, () => app.query(sql, [entryId])),
    ).rejects.toThrow(/permission denied|finora\.ledger: /);
    expect(await lineSnapshot(entryId)).toEqual(snapshot);
  });

  it("cannot be truncated, even by the migration role", async () => {
    await expect(admin.query("TRUNCATE finora.journal_lines")).rejects.toThrow(
      /cannot be truncated/,
    );
    await expect(
      admin.query("TRUNCATE finora.journal_entries CASCADE"),
    ).rejects.toThrow(/cannot be truncated/);
    await expect(app.query("TRUNCATE finora.journal_lines")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("runtime role cannot disable triggers", async () => {
    await expect(
      app.query("SET session_replication_role = replica"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      app.query("ALTER TABLE finora.journal_lines DISABLE TRIGGER ALL"),
    ).rejects.toThrow(/must be owner/);
  });

  it("drafts remain editable", async () => {
    const id = await asOwner(app, a.ownerId, () =>
      insertEntry(app, a.ownerId, [[accounts.cash!, "debit", 5]]),
    );
    await asOwner(app, a.ownerId, () =>
      app.query("DELETE FROM finora.journal_lines WHERE entry_id = $1", [id]),
    );
    expect(await lineSnapshot(id)).toEqual([]);
  });
});

describe("reversal links", () => {
  let original: string;

  beforeAll(async () => {
    original = await postedEntry([
      [accounts.cash!, "debit", 800],
      [accounts.income!, "credit", 800],
    ]);
  });

  it("rejects a 'reversal' that does not exactly offset the original", async () => {
    await expect(
      postedEntry(
        [
          [accounts.cash!, "credit", 700],
          [accounts.income!, "debit", 700],
        ],
        { reverses: original },
      ),
    ).rejects.toThrow(/exactly offset/);
    await expect(
      postedEntry(
        [
          [accounts.cash!, "debit", 800], // same direction, not a reversal
          [accounts.income!, "credit", 800],
        ],
        { reverses: original },
      ),
    ).rejects.toThrow(/exactly offset/);
  });

  it("rejects reversal and replacement links on drafts", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        insertEntry(
          app,
          a.ownerId,
          [
            [accounts.cash!, "credit", 800],
            [accounts.income!, "debit", 800],
          ],
          {
            reverses: original,
          },
        ),
      ),
    ).rejects.toThrow(/must be posted/);
  });

  it("rejects a replacement for an entry that was not reversed", async () => {
    await expect(
      postedEntry(
        [
          [accounts.cash!, "debit", 1],
          [accounts.income!, "credit", 1],
        ],
        { replaces: original },
      ),
    ).rejects.toThrow(/requires the original entry to be reversed/);
  });

  it("accepts an exact reversal once, and only once", async () => {
    const reversal = await postedEntry(
      [
        [accounts.income!, "debit", 800],
        [accounts.cash!, "credit", 800],
      ],
      { reverses: original },
    );
    expect(reversal).toBeTypeOf("string");
    await expect(
      postedEntry(
        [
          [accounts.income!, "debit", 800],
          [accounts.cash!, "credit", 800],
        ],
        { reverses: original },
      ),
    ).rejects.toThrow(/journal_entries_reverses_entry_key/);
    await expect(
      postedEntry(
        [
          [accounts.cash!, "debit", 800],
          [accounts.income!, "credit", 800],
        ],
        { reverses: reversal },
      ),
    ).rejects.toThrow(/non-reversal/);
    expect((await lineSnapshot(original)).map((r) => r.amount_minor)).toEqual([
      "800",
      "800",
    ]);
  });
});

describe("owner isolation (RLS and composite keys)", () => {
  let bEntry: string;

  beforeAll(async () => {
    bEntry = await asOwner(app, b.ownerId, async () => {
      const id = await insertEntry(app, b.ownerId, [
        [accounts.bCash!, "debit", 100],
        [accounts.bIncome!, "credit", 100],
      ]);
      await post(app, id);
      return id;
    });
  });

  it("cannot see another owner's accounts, entries or lines", async () => {
    const seen = await asOwner(app, a.ownerId, async () => ({
      accounts: (
        await app.query(
          "SELECT id FROM finora.ledger_accounts WHERE owner_id = $1",
          [b.ownerId],
        )
      ).rows,
      entries: (
        await app.query("SELECT id FROM finora.journal_entries WHERE id = $1", [
          bEntry,
        ])
      ).rows,
      lines: (
        await app.query(
          "SELECT id FROM finora.journal_lines WHERE entry_id = $1",
          [bEntry],
        )
      ).rows,
    }));
    expect(seen).toEqual({ accounts: [], entries: [], lines: [] });
  });

  it("cannot write rows owned by another owner", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query(
          "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, '2026-10-25', 'forged')",
          [b.ownerId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query(
          "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, 'x', 'asset', 'INR')",
          [b.ownerId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot reference another owner's account from its own entry", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        insertEntry(app, a.ownerId, [[accounts.bCash!, "debit", 1]]),
      ),
    ).rejects.toThrow(/journal_lines_account_fkey/);
  });

  it("cannot attach lines to, post, or reverse another owner's entry", async () => {
    await expect(
      asOwner(app, a.ownerId, () =>
        app.query(
          `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
           VALUES ($1, $2, 50, $3, 'INR', 'debit', 1)`,
          [a.ownerId, bEntry, accounts.cash],
        ),
      ),
    ).rejects.toThrow(/journal_lines_entry_fkey/);
    const updated = await asOwner(app, a.ownerId, () =>
      app.query(
        "UPDATE finora.journal_entries SET status = 'posted' WHERE id = $1",
        [bEntry],
      ),
    );
    expect(updated.rowCount).toBe(0);
    await expect(
      postedEntry(
        [
          [accounts.cash!, "credit", 100],
          [accounts.income!, "debit", 100],
        ],
        { reverses: bEntry },
      ),
    ).rejects.toThrow(/journal_entries_reverses_entry_fkey/);
  });

  it("errors the same way for a missing entry as for a foreign one (no existence oracle)", async () => {
    const attempt = (entryId: string) =>
      asOwner(app, a.ownerId, () =>
        app.query(
          `INSERT INTO finora.journal_lines (owner_id, entry_id, line_no, account_id, currency_code, side, amount_minor)
           VALUES ($1, $2, 1, $3, 'INR', 'debit', 1)`,
          [a.ownerId, entryId, accounts.cash],
        ),
      ).catch((error: Error & { code?: string; constraint?: string }) => [
        error.code,
        error.constraint,
      ]);
    expect(await attempt(bEntry)).toEqual(
      await attempt("00000000-0000-4000-8000-000000000000"),
    );
  });

  it("sees nothing without owner context", async () => {
    const rows = await asOwner(app, null, async () => ({
      accounts: (await app.query("SELECT 1 FROM finora.ledger_accounts"))
        .rowCount,
      entries: (await app.query("SELECT 1 FROM finora.journal_entries"))
        .rowCount,
      lines: (await app.query("SELECT 1 FROM finora.journal_lines")).rowCount,
    }));
    expect(rows).toEqual({ accounts: 0, entries: 0, lines: 0 });
    await expect(
      asOwner(app, null, () =>
        app.query(
          "INSERT INTO finora.journal_entries (owner_id, entry_date, description) VALUES ($1, '2026-10-25', 'x')",
          [a.ownerId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("checks balance at COMMIT with true data even if the context changed mid-transaction", async () => {
    await expect(
      asOwner(app, a.ownerId, async () => {
        const id = await insertEntry(app, a.ownerId, [
          [accounts.cash!, "debit", 3],
        ]);
        await post(app, id);
        await app.query("SELECT set_config('finora.owner_id', $1, true)", [
          b.ownerId,
        ]);
      }),
    ).rejects.toThrow(/unbalanced/);
  });
});
