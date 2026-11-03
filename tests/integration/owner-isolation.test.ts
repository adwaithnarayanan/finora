import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseOwnerId } from "@/domain/owner";
import type { AuthorizedOwner } from "@/server/auth/types";
import { PrismaOwnerDirectory } from "@/server/db/owner-directory";
import { runInIdentityContext, runInOwnerScope } from "@/server/db/scope";

import {
  TEST_PROVIDER,
  adminClient,
  appPrisma,
  deleteOwners,
  seedOwner,
  type SeededOwner,
} from "./support/db";
import { authorize as authorizeOn } from "./support/ledger";

const prisma = appPrisma();
let admin: pg.Client;
let a: SeededOwner;
let b: SeededOwner;
let disabled: SeededOwner;
let ownerA: AuthorizedOwner;

const authorize = (subject: string) => authorizeOn(prisma, subject);

beforeAll(async () => {
  admin = await adminClient();
  a = await seedOwner(admin);
  b = await seedOwner(admin);
  disabled = await seedOwner(admin, { disabled: true });
  ownerA = await authorize(a.subject);

  await admin.query(`
    DROP TABLE IF EXISTS finora.isolation_probe;
    CREATE TABLE finora.isolation_probe (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      owner_id uuid NOT NULL REFERENCES finora.owners (id),
      note text NOT NULL
    );
    SELECT finora.apply_owner_isolation('finora.isolation_probe');
    GRANT SELECT, INSERT, UPDATE, DELETE ON finora.isolation_probe TO finora_app;
  `);
  await admin.query(
    "INSERT INTO finora.isolation_probe (owner_id, note) VALUES ($1, 'a-1'), ($1, 'a-2'), ($2, 'b-1')",
    [a.ownerId, b.ownerId],
  );
});

afterAll(async () => {
  await admin.query("DROP TABLE IF EXISTS finora.isolation_probe");
  await deleteOwners(
    admin,
    [a, b, disabled].filter(Boolean).map((o) => o.ownerId),
  );
  await admin.end();
  await prisma.$disconnect();
});

type ProbeRow = { owner_id: string; note: string };

describe("owner resolution (identity context)", () => {
  it("resolves the verified identity to the internal owner id", async () => {
    expect(ownerA.ownerId).toBe(a.ownerId);
    expect(ownerA.ownerId).not.toBe(a.subject);
  });

  it("denies unknown identities and disabled owners", async () => {
    const directory = new PrismaOwnerDirectory(prisma);
    expect(
      await directory.findByIdentity({
        provider: TEST_PROVIDER,
        subject: "itest-nobody",
      }),
    ).toBeNull();
    expect(
      await directory.findByIdentity({
        provider: "supabase",
        subject: a.subject,
      }),
    ).toBeNull();
    expect(
      await directory.findByIdentity({
        provider: TEST_PROVIDER,
        subject: disabled.subject,
      }),
    ).toEqual({
      id: disabled.ownerId,
      disabled: true,
    });
  });

  it("exposes only the matching identity and owner, never others", async () => {
    const seen = await runInIdentityContext(
      prisma,
      { provider: TEST_PROVIDER, subject: b.subject },
      async (tx) => ({
        identities: await tx.ownerIdentity.findMany({
          select: { ownerId: true },
        }),
        owners: await tx.owner.findMany({ select: { id: true } }),
        probe: await tx.$queryRaw<
          ProbeRow[]
        >`SELECT owner_id::text, note FROM finora.isolation_probe`,
      }),
    );
    expect(seen.identities).toEqual([{ ownerId: b.ownerId }]);
    expect(seen.owners).toEqual([{ id: b.ownerId }]);
    expect(seen.probe).toEqual([]);
  });
});

describe("owner scope", () => {
  it("reads only the scoped owner's rows", async () => {
    const rows = await runInOwnerScope(
      prisma,
      ownerA,
      (tx) =>
        tx.$queryRaw<
          ProbeRow[]
        >`SELECT owner_id::text, note FROM finora.isolation_probe ORDER BY note`,
    );
    expect(rows.map((r) => r.note)).toEqual(["a-1", "a-2"]);
    const owners = await runInOwnerScope(prisma, ownerA, (tx) =>
      tx.owner.findMany({ select: { id: true } }),
    );
    expect(owners).toEqual([{ id: a.ownerId }]);
  });

  it("cannot read another owner's rows even when asking for them explicitly", async () => {
    const rows = await runInOwnerScope(
      prisma,
      ownerA,
      (tx) =>
        tx.$queryRaw<
          ProbeRow[]
        >`SELECT note FROM finora.isolation_probe WHERE owner_id = ${b.ownerId}::uuid`,
    );
    expect(rows).toEqual([]);
    const ownerB = await runInOwnerScope(prisma, ownerA, (tx) =>
      tx.owner.findUnique({ where: { id: b.ownerId } }),
    );
    expect(ownerB).toBeNull();
  });

  it("cannot insert rows for another owner", async () => {
    await expect(
      runInOwnerScope(
        prisma,
        ownerA,
        (tx) =>
          tx.$executeRaw`INSERT INTO finora.isolation_probe (owner_id, note) VALUES (${b.ownerId}::uuid, 'forged')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another owner's rows", async () => {
    const result = await runInOwnerScope(prisma, ownerA, async (tx) => ({
      updated:
        await tx.$executeRaw`UPDATE finora.isolation_probe SET note = 'hijacked' WHERE owner_id = ${b.ownerId}::uuid`,
      deleted:
        await tx.$executeRaw`DELETE FROM finora.isolation_probe WHERE owner_id = ${b.ownerId}::uuid`,
    }));
    expect(result).toEqual({ updated: 0, deleted: 0 });
    const { rows } = await admin.query(
      "SELECT note FROM finora.isolation_probe WHERE owner_id = $1",
      [b.ownerId],
    );
    expect(rows).toEqual([{ note: "b-1" }]);
  });

  it("cannot move its own rows to another owner", async () => {
    await expect(
      runInOwnerScope(
        prisma,
        ownerA,
        (tx) =>
          tx.$executeRaw`UPDATE finora.isolation_probe SET owner_id = ${b.ownerId}::uuid WHERE note = 'a-1'`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("can write its own rows", async () => {
    const inserted = await runInOwnerScope(
      prisma,
      ownerA,
      (tx) =>
        tx.$executeRaw`INSERT INTO finora.isolation_probe (owner_id, note) VALUES (${a.ownerId}::uuid, 'a-3')`,
    );
    expect(inserted).toBe(1);
  });
});

describe("fail-closed behaviour", () => {
  it("sees nothing without a scope", async () => {
    const rows = await prisma.$queryRaw<
      ProbeRow[]
    >`SELECT note FROM finora.isolation_probe`;
    expect(rows).toEqual([]);
    expect(await prisma.owner.findMany()).toEqual([]);
    expect(await prisma.ownerIdentity.findMany()).toEqual([]);
  });

  it("does not leak scope to the next transaction on the same pooled connection", async () => {
    await runInOwnerScope(prisma, ownerA, (tx) => tx.owner.findMany());
    const after = await prisma.$queryRaw<
      { owner: string | null }[]
    >`SELECT current_setting('finora.owner_id', true) AS owner`;
    expect(after[0]?.owner ?? "").toBe("");
    expect(
      await prisma.$queryRaw<
        ProbeRow[]
      >`SELECT note FROM finora.isolation_probe`,
    ).toEqual([]);
  });

  it("drops scope when the transaction rolls back", async () => {
    await expect(
      runInOwnerScope(prisma, ownerA, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      await prisma.$queryRaw<
        ProbeRow[]
      >`SELECT note FROM finora.isolation_probe`,
    ).toEqual([]);
  });

  it("rejects a forged owner object at runtime", async () => {
    const forged = {
      ownerId: "not-a-uuid",
      identity: { provider: "x", subject: "y" },
    } as unknown as AuthorizedOwner;
    await expect(
      runInOwnerScope(prisma, forged, (tx) => tx.owner.findMany()),
    ).rejects.toThrow(/canonical lowercase UUID/);
  });

  it("errors on a malformed context value instead of matching rows", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('finora.owner_id', 'garbage', true)`;
        return tx.$queryRaw`SELECT note FROM finora.isolation_probe`;
      }),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it("only scopes to ids that came from authorisation", () => {
    expect(parseOwnerId(b.ownerId)).toBe(b.ownerId);
  });
});
