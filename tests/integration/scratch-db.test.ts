import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCleanup } from "./support/cleanup";
import { adminClient } from "./support/db";
import {
  assertScratchName,
  createMigratedScratchDatabase,
  deployMigrations,
  redactCredentials,
  scratchDatabaseName,
} from "./support/scratch-db";

/**
 * The scratch-database helper's safety rules and failure paths, against the
 * LOCAL server. Every database created here is a fresh `finora_itest_scratch_*`
 * one (no migrations, for speed), and each test drops what it created.
 */

let admin: pg.Client;
const created: string[] = [];

async function exists(name: string): Promise<boolean> {
  const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rows.length === 1;
}

/** Records the name the helper chose, then does nothing (an empty database is enough here). */
const noMigrations = (url: URL) => {
  created.push(url.pathname.slice(1));
};

beforeAll(async () => {
  admin = await adminClient();
});

afterAll(async () => {
  // Safety net for a failed test: drop only the databases these tests created.
  await runCleanup([
    ...created.map((name) => [`drop ${name}`, () => admin.query(`DROP DATABASE IF EXISTS ${assertScratchName(name)} WITH (FORCE)`)] as const),
    ["close the admin connection", () => admin.end()],
  ]);
});

describe("names", () => {
  it("are unique per call, prefixed, and valid identifiers", () => {
    const names = new Set(Array.from({ length: 50 }, () => scratchDatabaseName("provisioning")));
    expect(names.size).toBe(50);
    for (const name of names) {
      expect(name).toMatch(/^finora_itest_provisioning_[0-9a-f]{12}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  it("reject labels that are not plain lower-case identifiers", () => {
    for (const label of ["", "Provisioning", "a-b", "x; DROP DATABASE postgres", "a".repeat(31)]) {
      expect(() => scratchDatabaseName(label), label).toThrow(/scratch database labels/);
    }
  });

  it("never accept a database this helper did not name", () => {
    for (const name of ["postgres", "finora_shadow", "finora_itest_provisioning", "finora_itest_x_ABCDEF012345", "finora_itest_x_0123456789ab; --"]) {
      expect(() => assertScratchName(name), name).toThrow(/refusing to use/);
    }
    expect(assertScratchName("finora_itest_x_0123456789ab")).toBe("finora_itest_x_0123456789ab");
  });
});

describe("migration errors", () => {
  it("redacts the connection URL and password from tool output", () => {
    const url = new URL("postgresql://postgres:p%40ss-word@127.0.0.1:54322/finora_itest_x_0123456789ab?schema=finora");
    const text = `failed at ${url.toString()} with p@ss-word and p%40ss-word`;
    const out = redactCredentials(text, url);
    expect(out).not.toMatch(/p@ss-word|p%40ss-word|postgresql:\/\//);
    expect(out).toContain("[redacted]");
  });

  it("reports Prisma's own output, without credentials, when migrate deploy fails", () => {
    // Nothing listens on port 1, so Prisma fails before touching any database.
    const url = new URL("postgresql://postgres:distinctive-probe-secret@127.0.0.1:1/finora_itest_unreachable_000000000000?schema=finora");
    let message = "";
    try {
      deployMigrations(url);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^prisma migrate deploy failed \(exit \d+\):/);
    expect(message).toMatch(/P1001|reach database server/);
    expect(message).not.toContain("distinctive-probe-secret");
  });
});

describe("lifecycle", () => {
  it("drops the new database when migration fails, and rethrows the migration error", async () => {
    let name = "";
    const failure = new Error("migration failed on purpose");
    await expect(
      createMigratedScratchDatabase("scratch", {
        migrate: (url) => {
          noMigrations(url);
          name = url.pathname.slice(1);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(name).toMatch(/^finora_itest_scratch_[0-9a-f]{12}$/);
    expect(await exists(name)).toBe(false);
  });

  it("gives concurrent callers different databases, and each drop removes only its own", async () => {
    const [first, second] = await Promise.all([
      createMigratedScratchDatabase("scratch", { migrate: noMigrations }),
      createMigratedScratchDatabase("scratch", { migrate: noMigrations }),
    ]);
    expect(first.name).not.toBe(second.name);
    expect(await exists(first.name)).toBe(true);
    expect(await exists(second.name)).toBe(true);
    await expect(first.client.query("SELECT current_database() AS db")).resolves.toMatchObject({ rows: [{ db: first.name }] });

    await first.drop();
    expect(await exists(first.name)).toBe(false);
    expect(await exists(second.name)).toBe(true);
    await first.drop(); // idempotent
    await second.drop();
    expect(await exists(second.name)).toBe(false);
  });
});

describe("runCleanup", () => {
  it("runs every step after a failure and reports each failure with its label", async () => {
    const ran: string[] = [];
    const error = await runCleanup([
      ["delete Auth user a", async () => {
        ran.push("a");
        throw new Error("Auth refused");
      }],
      ["drop the scratch database", async () => {
        ran.push("drop");
      }],
      ["close connection", async () => {
        ran.push("close");
        throw new Error("already closed");
      }],
    ]).then(() => null, (e: unknown) => e as AggregateError);
    expect(ran).toEqual(["a", "drop", "close"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error?.errors).toHaveLength(2);
    expect(error?.message).toBe("2 cleanup step(s) failed: delete Auth user a: Auth refused; close connection: already closed");
  });

  it("succeeds quietly when every step succeeds", async () => {
    await expect(runCleanup([["noop", async () => {}]])).resolves.toBeUndefined();
  });
});
