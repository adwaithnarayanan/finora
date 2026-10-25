-- Read-only check of the case-insensitive account-name index created by
-- migration 20261025000400_account_name_case_insensitive. Prisma cannot model
-- expression indexes, so `npm run db:local:drift` cannot see this one; this
-- query is how it is verified (integration tests run it locally; run it after
-- every hosted deployment, see docs/runbooks/hosted-setup.md).
--
-- Returns exactly one row. Every check column must be true; `ok` is their
-- conjunction. A missing index gives present = false and ok = false.
-- Run with search_path = pg_catalog so pg_get_indexdef prints the built-in
-- lower() unqualified (any other lower() would print schema-qualified and
-- fail the definition check).
SELECT checks.*,
       present AND on_expected_table AND is_unique AND is_valid_and_ready
         AND keys_are_owner_id_and_lower_name AND definition_matches AS ok
  FROM (
    SELECT
      count(*) = 1 AS present,
      coalesce(bool_and(tn.nspname = 'finora' AND t.relname = 'financial_accounts'), false) AS on_expected_table,
      coalesce(bool_and(x.indisunique), false) AS is_unique,
      coalesce(bool_and(x.indisvalid AND x.indisready AND x.indislive), false) AS is_valid_and_ready,
      coalesce(bool_and(
            am.amname = 'btree'
        AND x.indnatts = 2
        AND x.indnkeyatts = 2
        AND x.indpred IS NULL
        AND x.indkey[0] = (SELECT a.attnum FROM pg_attribute a
                            WHERE a.attrelid = t.oid AND a.attname = 'owner_id' AND NOT a.attisdropped)
        AND x.indkey[1] = 0
        AND pg_get_indexdef(x.indexrelid, 2, false) = 'lower(name)'
      ), false) AS keys_are_owner_id_and_lower_name,
      coalesce(bool_and(
        pg_get_indexdef(x.indexrelid)
          = 'CREATE UNIQUE INDEX financial_accounts_owner_name_ci_key ON finora.financial_accounts USING btree (owner_id, lower(name))'
      ), false) AS definition_matches,
      max(pg_get_indexdef(x.indexrelid)) AS definition
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace tn ON tn.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'finora' AND i.relname = 'financial_accounts_owner_name_ci_key'
  ) AS checks;
