import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";

import { type JournalEntry, type LedgerAccount, LedgerValidationError } from "@/domain/ledger";
import type { AuthorizedOwner } from "@/server/auth/types";
import { createPrismaClient } from "@/server/db/client";
import { LedgerNotFoundError } from "@/server/ledger/errors";

import { adminClient, appPrisma, deleteOwners, seedOwner, type SeededOwner } from "./support/db";
import { authorize, ledgerFor, line, newKey } from "./support/ledger";

/**
 * Owner isolation through the ledger service: owner A, holding a genuine
 * AuthorizedOwner, aims every operation at owner B's records.
 */

const prisma = appPrisma();
const ledger = ledgerFor(prisma);
let admin: pg.Client;
let seededA: SeededOwner;
let seededB: SeededOwner;
let ownerA: AuthorizedOwner;
let ownerB: AuthorizedOwner;
let aCash: LedgerAccount;
let bCash: LedgerAccount;
let bIncome: LedgerAccount;
let bPosted: JournalEntry;
let bDraft: JournalEntry;

const today = "2026-10-25";

async function snapshotB() {
  const { rows } = await admin.query(
    `SELECT e.id::text, e.status, e.reverses_entry_id, count(l.id)::int AS lines,
            coalesce(sum(l.amount_minor), 0)::text AS total
       FROM finora.journal_entries e LEFT JOIN finora.journal_lines l ON l.entry_id = e.id
      WHERE e.owner_id = $1 GROUP BY e.id ORDER BY e.id`,
    [seededB.ownerId],
  );
  return rows;
}

beforeAll(async () => {
  admin = await adminClient();
  seededA = await seedOwner(admin);
  seededB = await seedOwner(admin);
  ownerA = await authorize(prisma, seededA.subject);
  ownerB = await authorize(prisma, seededB.subject);
  aCash = await ledger.createAccount(ownerA, { name: "Cash", kind: "asset", currency: "INR" });
  bCash = await ledger.createAccount(ownerB, { name: "Cash", kind: "asset", currency: "INR" });
  bIncome = await ledger.createAccount(ownerB, { name: "Income", kind: "income", currency: "INR" });
  ({ entry: bPosted } = await ledger.postEntry(ownerB, {
    entryDate: today,
    description: "B posted",
    idempotencyKey: newKey("b"),
    lines: [line(bCash.id, "debit", "100"), line(bIncome.id, "credit", "100")],
  }));
  ({ entry: bDraft } = await ledger.createDraft(ownerB, {
    entryDate: today,
    description: "B draft",
    lines: [line(bCash.id, "debit", "5"), line(bIncome.id, "credit", "5")],
  }));
});

afterAll(async () => {
  await deleteOwners(admin, [seededA, seededB].filter(Boolean).map((o) => o.ownerId));
  await admin.end();
  await prisma.$disconnect();
});

describe("owner A against owner B's records", () => {
  it("cannot read B's entries or account balances", async () => {
    await expect(ledger.getEntry(ownerA, bPosted.id)).rejects.toThrow(LedgerNotFoundError);
    await expect(ledger.getAccountBalance(ownerA, bCash.id)).rejects.toThrow(LedgerNotFoundError);
  });

  it("cannot modify, post, validate, reverse or correct B's entries", async () => {
    const before = await snapshotB();
    const attempts = [
      ledger.replaceDraftLines(ownerA, bDraft.id, [line(aCash.id, "debit", "1")]),
      ledger.postDraft(ownerA, bDraft.id),
      ledger.validateDraft(ownerA, bDraft.id),
      ledger.reverseEntry(ownerA, bPosted.id, { entryDate: today, description: "x", idempotencyKey: newKey() }),
      ledger.correctEntry(ownerA, bPosted.id, {
        entryDate: today,
        description: "x",
        idempotencyKey: newKey(),
        replacement: { entryDate: today, description: "y", lines: [line(aCash.id, "debit", "1"), line(aCash.id, "credit", "1")] },
      }),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toThrow(LedgerNotFoundError);
    expect(await snapshotB()).toEqual(before);
  });

  it("cannot reference B's accounts in its own entries", async () => {
    const attempt = ledger.postEntry(ownerA, {
      entryDate: today,
      description: "Steal",
      idempotencyKey: newKey(),
      lines: [line(aCash.id, "debit", "1"), line(bIncome.id, "credit", "1")],
    });
    await expect(attempt).rejects.toThrow(LedgerValidationError);
    // Indistinguishable from an id that does not exist at all.
    await expect(attempt).rejects.toMatchObject({ issues: [{ code: "unknown-account", line: 1 }] });
  });

  it("does not see B's idempotency keys", async () => {
    const key = bPosted.idempotencyKey!;
    const { replayed } = await ledger.createDraft(ownerA, {
      entryDate: today,
      description: "Same key as B",
      idempotencyKey: key,
      lines: [line(aCash.id, "debit", "1")],
    });
    expect(replayed).toBe(false);
  });

  it("leaves B able to use its own records", async () => {
    await expect(ledger.postDraft(ownerB, bDraft.id)).resolves.toMatchObject({ replayed: false });
  });
});

describe("authorisation requirements", () => {
  it("rejects a forged owner object at runtime", async () => {
    const forged = { ownerId: "not-a-uuid", identity: { provider: "x", subject: "y" } } as unknown as AuthorizedOwner;
    await expect(ledger.getEntry(forged, bPosted.id)).rejects.toThrow(/canonical lowercase UUID/);
  });

  it("an owner id with no matching rows sees nothing (no context bleed)", async () => {
    const ghost = { ...ownerA, ownerId: "00000000-0000-4000-8000-000000000000" } as AuthorizedOwner;
    await expect(ledger.getEntry(ghost, bPosted.id)).rejects.toThrow(LedgerNotFoundError);
    // Writes by the ghost cannot satisfy RLS or the owner foreign key.
    await expect(ledger.createAccount(ghost, { name: "Ghost", kind: "asset", currency: "INR" })).rejects.toThrow();
  });

  it("does not leak scope to the next transaction on a reused connection", async () => {
    await ledger.getEntry(ownerB, bPosted.id);
    const leftover = await prisma.$queryRaw<{ owner: string | null }[]>`
      SELECT current_setting('finora.owner_id', true) AS owner`;
    expect(leftover[0]?.owner ?? "").toBe("");
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.journalLine.count()).toBe(0);
    expect(await prisma.ledgerAccount.count()).toBe(0);
  });
});

describe("error hygiene", () => {
  it("does not echo credentials when the database rejects the login", async () => {
    const url = new URL(inject("local").appDatabaseUrl);
    const secret = "wrong-password-0123456789";
    url.password = secret;
    const broken = createPrismaClient(url.toString(), 1);
    const brokenLedger = ledgerFor(broken);
    try {
      const error = await brokenLedger.getEntry(ownerA, bPosted.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      expect(text).toMatch(/authentication failed/i); // failed for the intended reason
      expect(text).not.toContain(secret);
      expect(text).not.toContain(url.toString());
    } finally {
      await broken.$disconnect();
    }
  });

  it("reports database refusals with Finora's own reason, not raw SQL", async () => {
    const buggy = ledgerFor(prisma, (store) => {
      const original = store.replaceLines.bind(store);
      return Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
        replaceLines: (id: Parameters<typeof original>[0], lines: Parameters<typeof original>[1]) =>
          original(id, lines.slice(0, 1)),
      });
    });
    const error = await buggy
      .postEntry(ownerA, {
        entryDate: today,
        description: "Buggy",
        idempotencyKey: newKey(),
        lines: [line(aCash.id, "debit", "1"), line(aCash.id, "credit", "1")],
      })
      .then(
        () => new Error("expected a rejection"),
        (e: unknown) => e as Error,
      );
    expect(error.message).toBe("The ledger rejected the change: posted journal entry is unbalanced");
    expect(error.message).not.toMatch(/INSERT|UPDATE|SELECT|postgres/i);
  });
});
