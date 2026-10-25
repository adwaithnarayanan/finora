import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { TEST_PROVIDER, adminClient, deleteOwners, seedOwner } from "./support/db";

let admin: pg.Client;
const created: string[] = [];

beforeAll(async () => {
  admin = await adminClient();
});

afterEach(async () => {
  await deleteOwners(admin, created.splice(0));
});

afterAll(async () => {
  await admin?.end();
});

async function newOwner(options?: Parameters<typeof seedOwner>[1]) {
  const owner = await seedOwner(admin, options);
  created.push(owner.ownerId);
  return owner;
}

const insertIdentity = (ownerId: string, provider: string, subject: string) =>
  admin.query(
    "INSERT INTO finora.owner_identities (owner_id, provider, subject) VALUES ($1, $2, $3)",
    [ownerId, provider, subject],
  );

describe("owner identity constraints", () => {
  it("generates UUID ids and timestamps", async () => {
    const { ownerId } = await newOwner();
    const { rows } = await admin.query(
      "SELECT id, created_at, updated_at, disabled_at FROM finora.owners WHERE id = $1",
      [ownerId],
    );
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].updated_at.getTime()).toBe(rows[0].created_at.getTime());
    expect(rows[0].disabled_at).toBeNull();
  });

  it("maps one provider subject to at most one owner", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await expect(insertIdentity(b.ownerId, TEST_PROVIDER, a.subject)).rejects.toThrow(
      /owner_identities_provider_subject_key/,
    );
  });

  it("allows one identity per provider per owner", async () => {
    const a = await newOwner();
    await expect(insertIdentity(a.ownerId, TEST_PROVIDER, "itest-second")).rejects.toThrow(
      /owner_identities_owner_provider_key/,
    );
  });

  it.each(["", "Supabase", "1abc", "a", "has space", "x".repeat(40)])(
    "rejects provider %j",
    async (provider) => {
      const a = await newOwner();
      await expect(insertIdentity(a.ownerId, provider, "itest-x")).rejects.toThrow(
        /owner_identities_provider_format/,
      );
    },
  );

  it.each(["", " padded", "padded ", "x".repeat(256)])("rejects subject %j", async (subject) => {
    const a = await newOwner();
    await expect(insertIdentity(a.ownerId, "other", subject)).rejects.toThrow(
      /owner_identities_subject_format/,
    );
  });

  it("requires an existing owner and prevents deleting a mapped owner", async () => {
    await expect(
      insertIdentity("00000000-0000-4000-8000-000000000000", TEST_PROVIDER, "itest-orphan"),
    ).rejects.toThrow(/owner_identities_owner_id_fkey/);
    const a = await newOwner();
    await expect(admin.query("DELETE FROM finora.owners WHERE id = $1", [a.ownerId])).rejects.toThrow(
      /owner_identities_owner_id_fkey/,
    );
  });

  it("maintains updated_at and timestamp ordering", async () => {
    const { ownerId } = await newOwner();
    await admin.query("UPDATE finora.owners SET disabled_at = now() WHERE id = $1", [ownerId]);
    const { rows } = await admin.query(
      "SELECT created_at, updated_at FROM finora.owners WHERE id = $1",
      [ownerId],
    );
    expect(rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(rows[0].created_at.getTime());
    await expect(
      admin.query("UPDATE finora.owners SET disabled_at = created_at - interval '1 day' WHERE id = $1", [ownerId]),
    ).rejects.toThrow(/owners_disabled_after_created/);
  });
});
