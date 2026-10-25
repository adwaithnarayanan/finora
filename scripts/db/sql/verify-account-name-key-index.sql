-- Read-only check of the account-name uniqueness rule created by migration
-- 20261025000500_account_name_key (ADR 0007): the unique index on
-- (owner_id, name_key), byte-wise ("C") collation on the key, and no older
-- name index left enforcing a different equivalence. Integration tests run
-- it locally; run it after every hosted deployment (docs/runbooks/hosted-setup.md).
--
-- Returns exactly one row. Every check column must be true; `ok` is their
-- conjunction. A missing index gives present = false and ok = false.
-- Run with search_path = pg_catalog so pg_get_indexdef prints names fully
-- qualified and the definition check is exact.
WITH c_collation AS (
  SELECT oid FROM pg_collation WHERE collname = 'C' AND collnamespace = 'pg_catalog'::regnamespace
), accounts AS (
  SELECT t.oid,
         (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'owner_id' AND NOT a.attisdropped) AS owner_attnum,
         (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'name_key' AND NOT a.attisdropped) AS key_attnum,
         (SELECT a.attnotnull AND a.attcollation = (SELECT oid FROM c_collation)
            FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'name_key' AND NOT a.attisdropped) AS key_column_ok
    FROM pg_class t
   WHERE t.relnamespace = 'finora'::regnamespace AND t.relname = 'financial_accounts'
)
SELECT checks.*,
       present AND on_expected_table AND is_unique AND is_valid_and_ready AND keys_are_owner_id_and_name_key
         AND key_collation_is_c AND key_column_is_c_and_not_null AND no_other_name_index AND definition_matches AS ok
  FROM (
    SELECT
      count(*) = 1 AS present,
      coalesce(bool_and(x.indrelid = (SELECT oid FROM accounts)), false) AS on_expected_table,
      coalesce(bool_and(x.indisunique), false) AS is_unique,
      coalesce(bool_and(x.indisvalid AND x.indisready AND x.indislive), false) AS is_valid_and_ready,
      coalesce(bool_and(
            am.amname = 'btree'
        AND x.indnatts = 2
        AND x.indnkeyatts = 2
        AND x.indpred IS NULL
        AND x.indexprs IS NULL
        AND x.indkey[0] = (SELECT owner_attnum FROM accounts)
        AND x.indkey[1] = (SELECT key_attnum FROM accounts)
      ), false) AS keys_are_owner_id_and_name_key,
      coalesce(bool_and(x.indcollation[1] = (SELECT oid FROM c_collation)), false) AS key_collation_is_c,
      coalesce((SELECT key_column_ok FROM accounts), false) AS key_column_is_c_and_not_null,
      -- e.g. the old (owner_id, lower(name)) or (owner_id, name) indexes.
      NOT EXISTS (
        SELECT 1 FROM pg_index o
         WHERE o.indrelid = (SELECT oid FROM accounts)
           AND o.indexrelid IS DISTINCT FROM max(i.oid)
           AND pg_get_indexdef(o.indexrelid) ~ '\m(name|name_key)\M'
      ) AS no_other_name_index,
      coalesce(bool_and(
        pg_get_indexdef(x.indexrelid)
          = 'CREATE UNIQUE INDEX financial_accounts_owner_name_key_key ON finora.financial_accounts USING btree (owner_id, name_key)'
      ), false) AS definition_matches,
      max(pg_get_indexdef(x.indexrelid)) AS definition
    FROM pg_class i
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_am am ON am.oid = i.relam
    WHERE i.relnamespace = 'finora'::regnamespace AND i.relname = 'financial_accounts_owner_name_key_key'
  ) AS checks;
