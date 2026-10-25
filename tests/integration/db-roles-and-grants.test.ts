import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KNOWN_CURRENCIES } from "@/domain/money";

import { adminClient, appClient } from "./support/db";

let admin: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  admin = await adminClient();
  app = await appClient();
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe("runtime role (finora_app)", () => {
  it("is the role the app connection actually uses", async () => {
    const { rows } = await app.query("SELECT current_user, session_user");
    expect(rows[0]).toEqual({ current_user: "finora_app", session_user: "finora_app" });
  });

  it("has no superuser, BYPASSRLS, role-creation or replication rights", async () => {
    const { rows } = await admin.query(
      `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit
         FROM pg_roles WHERE rolname = 'finora_app'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolinherit: false,
    });
  });

  it("is not a member of any other role", async () => {
    const { rows } = await admin.query(
      `SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
        WHERE m.member = 'finora_app'::regrole`,
    );
    expect(rows).toEqual([]);
  });

  it("owns nothing in the finora schema", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname FROM pg_class c
        WHERE c.relnamespace = 'finora'::regnamespace AND c.relowner = 'finora_app'::regrole
       UNION ALL
       SELECT p.proname FROM pg_proc p
        WHERE p.pronamespace = 'finora'::regnamespace AND p.proowner = 'finora_app'::regrole`,
    );
    expect(rows).toEqual([]);
    const schemaOwner = await admin.query(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'finora'`,
    );
    expect(schemaOwner.rows[0].owner).not.toBe("finora_app");
  });

  it("cannot create objects or write identity tables", async () => {
    await expect(app.query("CREATE TABLE finora.evil (id int)")).rejects.toThrow(/permission denied/);
    await expect(app.query("CREATE TABLE public.evil (id int)")).rejects.toThrow(/permission denied/);
    await expect(app.query("INSERT INTO finora.owners DEFAULT VALUES")).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE finora.owners SET disabled_at = now()")).rejects.toThrow(/permission denied/);
    await expect(app.query("DELETE FROM finora.owner_identities")).rejects.toThrow(/permission denied/);
    await expect(app.query("SELECT * FROM finora._prisma_migrations")).rejects.toThrow(/permission denied/);
  });

  it("cannot read Supabase's auth schema", async () => {
    await expect(app.query("SELECT id FROM auth.users LIMIT 1")).rejects.toThrow(/permission denied/);
  });

  it("cannot turn off RLS for its own session", async () => {
    await expect(app.query("SET row_security = off")).resolves.toBeDefined();
    // With row_security off, a query that RLS would filter must error rather than bypass.
    await expect(app.query("SELECT * FROM finora.owners")).rejects.toThrow(/row-level security/);
    await app.query("RESET row_security");
  });
});

describe("Supabase API roles", () => {
  it.each(["anon", "authenticated", "service_role", "authenticator"])(
    "%s has no access to the finora schema or its identity tables",
    async (role) => {
      const { rows } = await admin.query(
        `SELECT has_schema_privilege($1, 'finora', 'USAGE') AS usage,
                has_table_privilege($1, 'finora.owners', 'SELECT,INSERT,UPDATE,DELETE') AS owners,
                has_table_privilege($1, 'finora.owner_identities', 'SELECT,INSERT,UPDATE,DELETE') AS identities,
                has_table_privilege($1, 'finora._prisma_migrations', 'SELECT') AS migrations`,
        [role],
      );
      expect(rows[0]).toEqual({ usage: false, owners: false, identities: false, migrations: false });
    },
  );

  it("anon is refused even when it tries directly", async () => {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL ROLE anon");
      await expect(admin.query("SELECT * FROM finora.owners")).rejects.toThrow(/permission denied/);
    } finally {
      await admin.query("ROLLBACK");
    }
  });
});

describe("schema-wide guards (keep passing as tables are added)", () => {
  it("enables RLS on every application table", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname FROM pg_class c
        WHERE c.relnamespace = 'finora'::regnamespace AND c.relkind IN ('r', 'p')
          AND c.relname <> '_prisma_migrations' AND NOT c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("gives every owner_id table the owner_isolation policy", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'owner_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'finora'::regnamespace AND c.relkind IN ('r', 'p')
          AND c.relname <> 'owner_identities'
          AND NOT EXISTS (
            SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'owner_isolation')`,
    );
    expect(rows).toEqual([]);
  });

  it("grants nothing in finora to PUBLIC or the API roles", async () => {
    const { rows } = await admin.query(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'finora'
          AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'service_role', 'authenticator')`,
    );
    expect(rows).toEqual([]);
  });

  it("grants finora_app exactly the expected privileges (review before changing)", async () => {
    const { rows } = await admin.query(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'finora' AND grantee = 'finora_app'
       UNION ALL
       SELECT table_name || '.' || column_name, privilege_type FROM information_schema.column_privileges
        WHERE table_schema = 'finora' AND grantee = 'finora_app'
          AND (table_name, privilege_type) NOT IN (
            SELECT table_name, privilege_type FROM information_schema.role_table_grants
             WHERE table_schema = 'finora' AND grantee = 'finora_app')`,
    );
    expect(rows.map((r) => `${r.table_name}:${r.privilege_type}`).sort()).toEqual([
      "categories.archived_at:UPDATE",
      "categories.name:UPDATE",
      "categories:INSERT",
      "categories:SELECT",
      "category_ledger_accounts:INSERT",
      "category_ledger_accounts:SELECT",
      "currencies:SELECT",
      "financial_accounts.archived_at:UPDATE",
      "financial_accounts.name:UPDATE",
      "financial_accounts.name_key:UPDATE",
      "financial_accounts.type:UPDATE",
      "financial_accounts:DELETE",
      "financial_accounts:INSERT",
      "financial_accounts:SELECT",
      "journal_entries.status:UPDATE",
      "journal_entries:INSERT",
      "journal_entries:SELECT",
      "journal_lines:DELETE",
      "journal_lines:INSERT",
      "journal_lines:SELECT",
      // Milestone 4B: unused accounts only (foreign keys restrict the rest).
      "ledger_accounts:DELETE",
      "ledger_accounts:INSERT",
      "ledger_accounts:SELECT",
      "owner_identities:SELECT",
      "owners:SELECT",
      "system_ledger_accounts:INSERT",
      "system_ledger_accounts:SELECT",
      "transactions.note:UPDATE",
      "transactions.payee:UPDATE",
      "transactions.reversal_entry_id:UPDATE",
      "transactions:INSERT",
      "transactions:SELECT",
    ]);
  });

  it("uses the exact owner_isolation template on every owner-scoped table", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, p.polcmd, p.polpermissive,
              array(SELECT rolname::text FROM pg_roles WHERE oid = ANY (p.polroles) ORDER BY 1) AS roles,
              pg_get_expr(p.polqual, p.polrelid) AS using_expr,
              pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'finora'::regnamespace AND p.polname = 'owner_isolation'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([
      "categories",
      "category_ledger_accounts",
      "financial_accounts",
      "journal_entries",
      "journal_lines",
      "ledger_accounts",
      "system_ledger_accounts",
      "transactions",
    ]);
    for (const row of rows) {
      expect(row, row.relname).toEqual({
        relname: row.relname,
        polcmd: "*",
        polpermissive: true,
        roles: ["finora_app"],
        using_expr: "(owner_id = finora.current_owner_id())",
        check_expr: "(owner_id = finora.current_owner_id())",
      });
    }
  });

  it("has no other policies on owner-scoped tables that could widen access", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, p.polname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'owner_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'finora'::regnamespace AND p.polname <> 'owner_isolation'`,
    );
    expect(rows).toEqual([{ relname: "owner_identities", polname: "identity_resolution" }]);
  });

  it("keeps every foreign key between owner-scoped tables within one owner", async () => {
    // A key from one owner_id table to another must carry owner_id on both
    // sides at the same position, so a row can never reference another
    // owner's row. References to `owners` itself must be on owner_id.
    const { rows } = await admin.query(
      `SELECT con.conname,
              array(SELECT attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute ON attrelid = con.conrelid AND attnum = k.n ORDER BY i) AS cols,
              array(SELECT attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                      JOIN pg_attribute ON attrelid = con.confrelid AND attnum = k.n ORDER BY i) AS ref_cols,
              con.confrelid::regclass::text AS target
         FROM pg_constraint con
        WHERE con.contype = 'f' AND con.connamespace = 'finora'::regnamespace
          AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = con.conrelid AND attname = 'owner_id' AND NOT attisdropped)`,
    );
    const ownerScoped = await admin.query(
      `SELECT c.oid::regclass::text AS name FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'owner_id' AND NOT a.attisdropped
        WHERE c.relnamespace = 'finora'::regnamespace AND c.relkind = 'r'`,
    );
    const scoped = new Set(ownerScoped.rows.map((r) => r.name));
    const violations = rows.filter((fk) => {
      if (fk.target === "finora.owners") return !(fk.cols.length === 1 && fk.cols[0] === "owner_id");
      if (!scoped.has(fk.target)) return false; // reference data such as currencies
      const i = fk.cols.indexOf("owner_id");
      return i === -1 || fk.ref_cols[i] !== "owner_id";
    });
    expect(violations).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it("includes owner_id in every unique index on owner-scoped tables (no cross-owner existence oracle)", async () => {
    // Unique indexes are checked without RLS, so a violation would reveal that
    // another owner's value exists. Primary keys are server-generated UUIDs.
    // owner_identities is exempt: (provider, subject) is globally unique by
    // design and finora_app cannot write that table.
    const { rows } = await admin.query(
      `SELECT c.relname, i.relname AS index
         FROM pg_index x JOIN pg_class c ON c.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_attribute oa ON oa.attrelid = c.oid AND oa.attname = 'owner_id' AND NOT oa.attisdropped
        WHERE c.relnamespace = 'finora'::regnamespace AND x.indisunique AND NOT x.indisprimary
          AND c.relname <> 'owner_identities'
          AND NOT (oa.attnum = ANY (x.indkey))`,
    );
    expect(rows).toEqual([]);
  });

  it("pins search_path on every finora function and keeps SECURITY DEFINER to the reviewed set", async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS config
         FROM pg_proc p WHERE p.pronamespace = 'finora'::regnamespace ORDER BY 1`,
    );
    for (const row of rows) expect(row.config, row.proname).toContain("search_path=");
    expect(rows.filter((r) => r.prosecdef).map((r) => r.proname)).toEqual([
      "financial_accounts_guard",
      "journal_entries_validate",
      "journal_lines_guard",
      "journal_lines_validate",
      "ledger_mappings_guard",
      "transactions_insert_guard",
      "transactions_validate",
    ]);
  });

  it("stores the same currencies (code and exponent) as the money module knows", async () => {
    const { rows } = await admin.query("SELECT code, exponent FROM finora.currencies ORDER BY code");
    const known = Object.values(KNOWN_CURRENCIES)
      .map((c) => ({ code: c.code, exponent: c.exponent }))
      .sort((x, y) => x.code.localeCompare(y.code));
    expect(rows).toEqual(known);
  });

  it("does not let PUBLIC execute finora functions", async () => {
    const { rows } = await admin.query(
      `SELECT p.proname FROM pg_proc p
        WHERE p.pronamespace = 'finora'::regnamespace
          AND has_function_privilege('anon', p.oid, 'EXECUTE')`,
    );
    expect(rows).toEqual([]);
  });
});
