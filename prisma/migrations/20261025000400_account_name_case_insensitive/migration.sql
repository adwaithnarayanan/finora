-- Account names are unique per owner regardless of letter case ("Cash" and
-- "cash" cannot coexist). The service already checks this for a friendly
-- error; this index makes it hold under concurrency and for every writer.
-- Hand-written: Prisma's schema language cannot express an expression index.
-- See docs/adr/0006-accounts-and-transactions.md.

-- 1. Refuse to proceed (changing nothing) if existing names already collide.
--    Accounts are never renamed or deleted automatically: resolve conflicts
--    by renaming accounts, then re-run migrations (see the hosted runbook).
DO $$
DECLARE
  conflicts integer;
BEGIN
  SELECT count(*) INTO conflicts
    FROM (
      SELECT 1 FROM "finora"."financial_accounts"
       GROUP BY "owner_id", lower("name")
      HAVING count(*) > 1
    ) AS duplicate_groups;
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'finora: % group(s) of account names differ only by letter case; rename them before applying this migration', conflicts
      USING HINT = 'Find them with: SELECT owner_id, lower(name), count(*) FROM finora.financial_accounts GROUP BY 1, 2 HAVING count(*) > 1';
  END IF;
END
$$;

-- 2. Includes owner_id (as every unique index on an owner-scoped table must),
--    so different owners can use the same name and a violation reveals nothing
--    about other owners.
CREATE UNIQUE INDEX "financial_accounts_owner_name_ci_key"
  ON "finora"."financial_accounts" ("owner_id", lower("name"));
