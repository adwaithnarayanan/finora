import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { canonicalAccountName } from "@/domain/finance";
import { createPrismaClient } from "@/server/db/client";
import { IdempotencyConflictError } from "@/server/ledger/errors";

import {
  extractGeneratedBlock,
  textCodePoints,
} from "../../scripts/lib/account-name-key-sql.mjs";
import { analyseAccountNames } from "../../scripts/lib/account-names.mjs";
import { assertLoopback } from "../../scripts/lib/local-supabase.mjs";

import { runCleanup } from "./support/cleanup";
import { TEST_PROVIDER, adminClient } from "./support/db";
import { authorize, financeFor } from "./support/ledger";
import {
  type MigrationSet,
  type ScratchDatabase,
  createMigratedScratchDatabase,
  deployMigrations,
  migrationSet,
  runPrisma,
} from "./support/scratch-db";

const NAME = "20261025000500_account_name_key";
const PREVIOUS = "20261025000400_account_name_case_insensitive";
const MIGRATION_SQL = readFileSync(
  path.join(process.cwd(), "prisma/migrations", NAME, "migration.sql"),
  "utf8",
);
const appKey = (s: string) => s.normalize("NFC").toLowerCase().normalize("NFC");
const hexOf = (s: string) =>
  [...s].map((c) => c.codePointAt(0)!.toString(16).padStart(4, "0")).join(" ");

let admin: pg.Client;
const scratches: ScratchDatabase[] = [];
const sets: MigrationSet[] = [];

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  await runCleanup([
    ...scratches.map((s) => [`drop ${s.name}`, () => s.drop()] as const),
    ...sets.map(
      (s) =>
        ["remove a temporary migrations copy", async () => s.remove()] as const,
    ),
    ["close the admin connection", () => admin?.end()],
  ]);
});

async function sqlKeys(client: pg.Client, inputs: readonly string[]) {
  const out: { key: string; assigned: boolean }[] = [];
  for (let i = 0; i < inputs.length; i += 100_000) {
    const { rows } = await client.query<{ key: string; assigned: boolean }>(
      `SELECT pg_temp.finora_account_name_key(s) AS key, unicode_assigned(s) AS assigned
         FROM unnest($1::text[]) WITH ORDINALITY AS u(s, i) ORDER BY i`,
      [inputs.slice(i, i + 100_000)],
    );
    out.push(...rows);
  }
  return out;
}

async function compare(client: pg.Client, inputs: readonly string[]) {
  const results = await sqlKeys(client, inputs);
  const differing = inputs.flatMap((input, i) =>
    results[i]!.key === appKey(input) ? [] : [{ input, ...results[i]! }],
  );
  return {
    unexplained: differing.filter((d) => d.assigned).map((d) => hexOf(d.input)),
    unassignedHere: differing.length,
  };
}

describe("the migration's SQL key function agrees with the application on PostgreSQL", () => {
  let session: pg.Client;

  beforeAll(async () => {
    session = await adminClient();
    const block = extractGeneratedBlock(MIGRATION_SQL);
    if (!block) throw new Error("generated block not found in the migration");
    await session.query(block);
  });

  afterAll(async () => {
    await session?.end();
  });

  it("for every code point on its own", async () => {
    const inputs = [...textCodePoints()].map((cp) => String.fromCodePoint(cp));
    const { unexplained, unassignedHere } = await compare(session, inputs);
    expect(unexplained).toEqual([]);
    expect(unassignedHere).toBeLessThan(2_000);
  }, 300_000);

  it("for capital sigma next to every cased and case-ignorable character, and a sample of the rest", async () => {
    const neighbours = [...textCodePoints()].filter(
      (cp) =>
        cp % 61 === 0 ||
        /[\p{Cased}\p{Case_Ignorable}]/u.test(String.fromCodePoint(cp)),
    );
    const inputs = neighbours.flatMap((cp) => {
      const c = String.fromCodePoint(cp);
      return [
        `A${c}\u03a3`,
        `1${c}\u03a3`,
        `A\u03a3${c}`,
        `A\u03a3${c}b`,
        `${c}\u03a3`,
        `\u03a3${c}`,
        `A${c}${c}\u03a3 x`,
      ];
    });
    expect((await compare(session, inputs)).unexplained).toEqual([]);
  }, 300_000);

  it("for every canonical composition and for reordered combining marks", async () => {
    const decomposable = [...textCodePoints()]
      .map((cp) => String.fromCodePoint(cp).normalize("NFD"))
      .filter((nfd) => [...nfd].length > 1);
    const marks = [
      0x0300, 0x0301, 0x0307, 0x0308, 0x0323, 0x0327, 0x0328, 0x0331, 0x0345,
      0x05b0, 0x0e48, 0x1dc0, 0x20d0, 0x302a,
    ].map((cp) => String.fromCodePoint(cp));
    const reordered = marks.flatMap((m1) =>
      marks.flatMap((m2) => [
        `a${m1}${m2}`,
        `\u0391${m1}${m2}\u03a3`,
        `S${m2}${m1}`,
      ]),
    );
    expect(
      (await compare(session, [...decomposable, ...reordered])).unexplained,
    ).toEqual([]);
  }, 300_000);

  it("for the policy examples", async () => {
    const examples = [
      "Cafe\u0301",
      "CAF\u00c9",
      "\u0130stanbul",
      "\u0131stanbul",
      "ISTANBUL",
      "\u039f\u0394\u039f\u03a3",
      "\u03a3\u0391\u03a3 \u03a3\u0391\u03a3",
      "\u039f\u03a3\u0301",
      "Stra\u00dfe",
      "STRA\u1e9eE",
      "\ufb01le",
    ];
    const results = await sqlKeys(session, examples);
    expect(results.map((r) => r.key)).toEqual(
      examples.map((e) => canonicalAccountName(e).key),
    );
  });

  it("recognises exactly the whitespace trim() removes", async () => {
    const { rows } = await session.query<{ s: string; trimmed: boolean }>(
      "SELECT s, pg_temp.finora_account_name_is_trimmed(s) AS trimmed FROM unnest($1::text[]) AS s",
      [
        [
          "Cash",
          "\u00a0Cash",
          "Cash\u3000",
          "\ufeffCash",
          "\u200bCash",
          "Ca sh",
          "\tCash",
          "Cash\u2028",
        ],
      ],
    );
    for (const row of rows)
      expect(row.trimmed, hexOf(row.s)).toBe(row.s === row.s.trim());
  });
});

async function previousSchemaDatabase(label: string): Promise<ScratchDatabase> {
  const set = migrationSet({ through: PREVIOUS });
  sets.push(set);
  const scratch = await createMigratedScratchDatabase(label, {
    migrate: (url) => deployMigrations(url, set),
  });
  scratches.push(scratch);
  return scratch;
}

async function seed(db: pg.Client, owners: readonly (readonly string[])[]) {
  const ids: { ownerId: string; accountIds: string[] }[] = [];
  for (const names of owners) {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO finora.owners DEFAULT VALUES RETURNING id::text",
    );
    const ownerId = rows[0]!.id;
    const accountIds: string[] = [];
    for (const [i, name] of names.entries()) {
      const ledger = await db.query<{ id: string }>(
        "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, $2, 'asset', 'INR') RETURNING id::text",
        [ownerId, `itest:${i}`],
      );
      const account = await db.query<{ id: string }>(
        `INSERT INTO finora.financial_accounts (owner_id, name, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
         VALUES ($1, $2, 'bank', 'INR', $3, $4, repeat('0', 64)) RETURNING id::text`,
        [ownerId, name, ledger.rows[0]!.id, `itest-${i}`],
      );
      accountIds.push(account.rows[0]!.id);
    }
    ids.push({ ownerId, accountIds });
  }
  return ids;
}

async function snapshot(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT id::text, owner_id::text, name, type::text, currency_code, ledger_account_id::text, creation_key,
            creation_fingerprint, created_at, updated_at, archived_at
       FROM finora.financial_accounts ORDER BY id`,
  );
  return rows.map((r) => ({ ...r, name: hexOf(r.name) }));
}

async function schemaState(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT to_regclass('finora.financial_accounts_owner_name_ci_key')::text AS ci_index,
            to_regclass('finora.financial_accounts_owner_name_key')::text AS exact_index,
            to_regclass('finora.financial_accounts_owner_name_key_key')::text AS key_index,
            EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'finora.financial_accounts'::regclass
                     AND attname = 'name_key' AND NOT attisdropped) AS has_key_column,
            (SELECT count(*)::int FROM pg_proc WHERE proname LIKE 'finora_account_name%') AS helper_functions`,
  );
  return rows[0];
}

const BEFORE = {
  ci_index: "finora.financial_accounts_owner_name_ci_key",
  exact_index: "finora.financial_accounts_owner_name_key",
  key_index: null,
  has_key_column: false,
  helper_functions: 0,
};

async function migrationRow(db: pg.Client) {
  const { rows } = await db.query(
    `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back, logs
       FROM finora._prisma_migrations WHERE migration_name = $1 ORDER BY started_at`,
    [NAME],
  );
  return rows;
}

describe("migration on existing data", () => {
  it("backfills the application's keys, rewrites names to NFC only, and builds the index", async () => {
    const scratch = await previousSchemaDatabase("namekey_ok");
    const db = scratch.client;
    const names = [
      "Cafe\u0301", // NFD: becomes NFC
      "Stra\u00dfe",
      "STRASSE", // policy: different
      "\u0130stanbul",
      "Istanbul",
      "\u0131stanbul", // different
      "\u039f\u0394\u039f\u03a3",
      "\u03bf\u03b4\u03bf\u03c3", // final vs medial sigma: different
      "\u212b Fund", // ANGSTROM SIGN: becomes \u00c5
      "Plain",
    ];
    const [a, b] = await seed(db, [names, ["Caf\u00e9", "plain"]]);
    const before = await snapshot(db);

    deployMigrations(scratch.url);

    const after = await snapshot(db);
    const { rows } = await db.query<{
      id: string;
      name: string;
      name_key: string;
    }>("SELECT id::text, name, name_key FROM finora.financial_accounts");
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [i, original] of names.entries()) {
      const row = byId.get(a!.accountIds[i]!)!;
      expect(hexOf(row.name), original).toBe(hexOf(original.normalize("NFC")));
      expect(hexOf(row.name_key), original).toBe(
        hexOf(canonicalAccountName(original).key),
      );
    }
    expect(byId.get(b!.accountIds[0]!)!.name_key).toBe("caf\u00e9");
    const strip = (accounts: Record<string, unknown>[]) =>
      accounts.map((account) =>
        Object.fromEntries(
          Object.entries(account).filter(
            ([column]) => column !== "name" && column !== "updated_at",
          ),
        ),
      );
    expect(strip(after)).toEqual(strip(before));
    expect(after.filter((r, i) => r.name !== before[i]!.name)).toHaveLength(2);
    for (const [i, row] of after.entries())
      expect(row.updated_at.getTime()).toBeGreaterThan(
        before[i]!.updated_at.getTime(),
      );

    expect(await schemaState(db)).toEqual({
      ci_index: null,
      exact_index: null,
      key_index: "finora.financial_accounts_owner_name_key_key",
      has_key_column: true,
      helper_functions: 0, // the pg_temp helpers did not outlive the migration
    });
    expect(await migrationRow(db)).toEqual([
      expect.objectContaining({ finished: true, rolled_back: false }),
    ]);

    const check = await db.query(
      `SELECT id::text AS id, owner_id::text AS "ownerId", name, name_key AS "nameKey", unicode_assigned(name) AS assigned
         FROM finora.financial_accounts`,
    );
    const analysis = analyseAccountNames(check.rows, { mode: "verify" });
    expect(analysis).toMatchObject({
      nameNotCanonical: [],
      keyMismatch: [],
      conflicts: [],
      untrimmed: [],
      tooLong: [],
    });
  }, 120_000);

  it("refuses colliding names, changing nothing, and applies after they are renamed", async () => {
    const scratch = await previousSchemaDatabase("namekey_conflict");
    const db = scratch.client;
    const [a] = await seed(db, [["Caf\u00e9", "CAFE\u0301", "Other"]]);
    const before = await snapshot(db);

    expect(() => deployMigrations(scratch.url)).toThrow(
      /1 group\(s\) of account names of one owner would share a comparison key/,
    );

    expect(await snapshot(db)).toEqual(before);
    expect(await schemaState(db)).toEqual(BEFORE);
    expect(await migrationRow(db)).toEqual([
      expect.objectContaining({ finished: false, rolled_back: false }),
    ]);
    const check = await db.query(
      `SELECT id::text AS id, owner_id::text AS "ownerId", name, unicode_assigned(name) AS assigned FROM finora.financial_accounts`,
    );
    expect(
      analyseAccountNames(check.rows, { mode: "preflight" }).conflicts,
    ).toEqual([
      {
        ownerId: a!.ownerId,
        accountIds: [a!.accountIds[0]!, a!.accountIds[1]!].sort(),
      },
    ]);
    expect(() => deployMigrations(scratch.url)).toThrow(
      /P3009|failed migrations/,
    );

    await db.query(
      "UPDATE finora.financial_accounts SET name = 'Caf\u00e9 (old)' WHERE id = $1",
      [a!.accountIds[1]],
    );
    runPrisma(scratch.url, ["migrate", "resolve", "--rolled-back", NAME]);
    deployMigrations(scratch.url);
    const { rows } = await db.query(
      "SELECT id::text, name, name_key FROM finora.financial_accounts ORDER BY name_key",
    );
    expect(rows.map((r) => [r.id, r.name, r.name_key])).toEqual([
      [a!.accountIds[0], "Caf\u00e9", "caf\u00e9"],
      [a!.accountIds[1], "Caf\u00e9 (old)", "caf\u00e9 (old)"],
      [a!.accountIds[2], "Other", "other"],
    ]);
  }, 120_000);

  it("gives up after lock_timeout instead of waiting behind another transaction, changing nothing", async () => {
    const scratch = await previousSchemaDatabase("namekey_lock");
    const db = scratch.client;
    await seed(db, [["Cafe\u0301"]]);
    const before = await snapshot(db);

    await db.query("BEGIN");
    await db.query("LOCK TABLE finora.financial_accounts IN ACCESS SHARE MODE");
    const started = Date.now();
    try {
      expect(() => deployMigrations(scratch.url)).toThrow(/lock timeout/);
    } finally {
      await db.query("ROLLBACK");
    }
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(5_000);
    expect(waited).toBeLessThan(60_000);

    expect(await snapshot(db)).toEqual(before);
    expect(await schemaState(db)).toEqual(BEFORE);
    expect(await migrationRow(db)).toEqual([
      expect.objectContaining({ finished: false, rolled_back: false }),
    ]);
    runPrisma(scratch.url, ["migrate", "resolve", "--rolled-back", NAME]);
    deployMigrations(scratch.url);
    expect((await schemaState(db)).key_index).toBe(
      "finora.financial_accounts_owner_name_key_key",
    );
  }, 120_000);

  describe("refusals and rollback", () => {
    let scratch: ScratchDatabase;

    beforeAll(async () => {
      scratch = await previousSchemaDatabase("namekey_refuse");
      await seed(scratch.client, [["Existing"]]);
    }, 120_000);

    async function attempt(
      setup: (db: pg.Client, ownerId: string) => Promise<unknown>,
    ) {
      const db = scratch.client;
      await db.query("BEGIN");
      try {
        const { rows } = await db.query<{ id: string }>(
          "SELECT owner_id::text AS id FROM finora.financial_accounts LIMIT 1",
        );
        await setup(db, rows[0]!.id);
        await db.query("SAVEPOINT before_migration");
        const error = await db.query(MIGRATION_SQL).then(
          () => null,
          (e: unknown) => e as Error,
        );
        await db.query("ROLLBACK TO SAVEPOINT before_migration");
        expect(await schemaState(db)).toEqual(BEFORE);
        return error?.message ?? null;
      } finally {
        await db.query("ROLLBACK");
      }
    }

    const insert = (db: pg.Client, ownerId: string, name: string) =>
      db
        .query<{ id: string }>(
          "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, $2, 'asset', 'INR') RETURNING id::text",
          [ownerId, `itest:${randomUUID()}`],
        )
        .then(({ rows }) =>
          db.query(
            `INSERT INTO finora.financial_accounts (owner_id, name, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
             VALUES ($1, $2, 'bank', 'INR', $3, $4, repeat('0', 64))`,
            [ownerId, name, rows[0]!.id, `itest-${rows[0]!.id}`],
          ),
        );

    it.each([
      [
        "a character unassigned in the server's Unicode",
        "Bank \u1c89",
        /characters unassigned in this server's Unicode/,
      ],
      [
        "whitespace the application would trim",
        "\u00a0Bank",
        /start or end with whitespace the application would trim/,
      ],
      [
        "a name longer than 60 characters after NFC",
        "\u0958".repeat(31),
        /would exceed 60 characters after NFC/,
      ],
      [
        "a collision",
        ["Caf\u00e9", "CAFE\u0301"],
        /would share a comparison key/,
      ],
    ])("refuses %s", async (_label, names, message) => {
      const all = typeof names === "string" ? [names] : names;
      expect(
        await attempt(async (db, ownerId) => {
          for (const name of all) await insert(db, ownerId, name);
        }),
      ).toMatch(message);
    });

    it("applies cleanly on the same data without the offending row (control)", async () => {
      expect(await attempt(async () => undefined)).toBeNull();
    });

    it("rolls back every statement when it fails after its DDL, through prisma migrate deploy", async () => {
      const db = scratch.client;
      await insert(
        db,
        (
          await db.query(
            "SELECT owner_id::text AS id FROM finora.financial_accounts LIMIT 1",
          )
        ).rows[0].id,
        "Cafe\u0301 Late",
      );
      const before = await snapshot(db);
      const failing = migrationSet({
        append: {
          [NAME]: "SELECT 1 / 0; -- itest: fail after every statement above",
        },
      });
      sets.push(failing);
      expect(() => deployMigrations(scratch.url, failing)).toThrow(
        /division by zero/,
      );
      expect(await snapshot(db)).toEqual(before);
      expect(await schemaState(db)).toEqual(BEFORE);
      expect(await migrationRow(db)).toEqual([
        expect.objectContaining({ finished: false }),
      ]);
    }, 120_000);
  });
});

describe("idempotent account creation across the migration (v1 fingerprints)", () => {
  const v1 = (
    name: string,
    opening: { amount: string; date: string } | null = null,
  ) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          "v1",
          name.trim(),
          "bank",
          "INR",
          opening?.amount ?? null,
          opening?.date ?? null,
        ]),
      )
      .digest("hex");

  it("replays a pre-migration NFD request, refuses changed details, and replays NFC requests", async () => {
    const scratch = await previousSchemaDatabase("namekey_retry");
    const db = scratch.client;

    const typed = "  Cafe\u0301 Fund ";
    const creationKey = randomUUID();
    const subject = `itest-${randomUUID()}`;
    const ownerId = (
      await db.query<{ id: string }>(
        "INSERT INTO finora.owners DEFAULT VALUES RETURNING id::text",
      )
    ).rows[0]!.id;
    await db.query(
      "INSERT INTO finora.owner_identities (owner_id, provider, subject) VALUES ($1, $2, $3)",
      [ownerId, TEST_PROVIDER, subject],
    );
    const ledger = await db.query<{ id: string }>(
      "INSERT INTO finora.ledger_accounts (owner_id, name, kind, currency_code) VALUES ($1, 'itest:retry', 'asset', 'INR') RETURNING id::text",
      [ownerId],
    );
    const accountId = (
      await db.query<{ id: string }>(
        `INSERT INTO finora.financial_accounts (owner_id, name, type, currency_code, ledger_account_id, creation_key, creation_fingerprint)
         VALUES ($1, $2, 'bank', 'INR', $3, $4, $5) RETURNING id::text`,
        [ownerId, typed.trim(), ledger.rows[0]!.id, creationKey, v1(typed)],
      )
    ).rows[0]!.id;

    deployMigrations(scratch.url);
    const stored = await db.query(
      "SELECT name, name_key, creation_fingerprint FROM finora.financial_accounts WHERE id = $1",
      [accountId],
    );
    expect(stored.rows[0]).toEqual({
      name: "Caf\u00e9 Fund",
      name_key: "caf\u00e9 fund",
      creation_fingerprint: v1(typed),
    });

    const appUrl = new URL(inject("local").appDatabaseUrl);
    assertLoopback(appUrl.toString(), "scratch database server");
    appUrl.pathname = `/${scratch.name}`;
    const prisma = createPrismaClient(appUrl.toString(), 1);
    try {
      const finance = financeFor(prisma);
      const owner = await authorize(prisma, subject);
      const accounts = async () =>
        (
          await db.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM finora.financial_accounts WHERE owner_id = $1",
            [ownerId],
          )
        ).rows[0]!.n;

      const retry = { name: typed, type: "bank", idempotencyKey: creationKey };
      expect(await finance.createAccount(owner, retry)).toEqual({
        value: expect.objectContaining({
          id: accountId,
          name: "Caf\u00e9 Fund",
        }),
        replayed: true,
      });

      for (const changed of [
        { name: "Cafe\u0301 Funds" },
        { type: "cash" },
        { currency: "USD" },
        { openingBalance: { amount: "10", date: "2026-10-01" } },
      ]) {
        await expect(
          finance.createAccount(owner, { ...retry, ...changed }),
          JSON.stringify(changed),
        ).rejects.toThrow(IdempotencyConflictError);
      }
      expect(await accounts()).toBe(1);

      for (const name of ["Caf\u00e9 Pot", "Tea\u0301 Pot"]) {
        const request = {
          name,
          type: "bank",
          openingBalance: { amount: "5", date: "2026-10-01" },
          idempotencyKey: randomUUID(),
        };
        const first = await finance.createAccount(owner, request);
        expect(first.value.name).toBe(name.normalize("NFC"));
        expect(await finance.createAccount(owner, request)).toEqual({
          value: first.value,
          replayed: true,
        });
        await expect(
          finance.createAccount(owner, { ...request, name: `${name} 2` }),
        ).rejects.toThrow(IdempotencyConflictError);
      }
      expect(await accounts()).toBe(3);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});
