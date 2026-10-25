-- Credit cards (docs/adr/0008-credit-card-accounts.md), step 2 of 2: the
-- account-class invariant and class-aware opening balances.
--
--  * finora.financial_account_ledger_kind(type) is the database's copy of the
--    application's mapping ACCOUNT_LEDGER_KIND (src/domain/finance/accounts.ts):
--    bank and cash are assets, credit cards are liabilities. A test compares
--    the two for every enum value.
--  * financial_accounts_guard: an account's ledger account must be of its
--    type's class, checked on INSERT and whenever the type changes (bank <->
--    cash stays allowed; to or from credit_card is refused).
--  * assert_transaction_valid (deferred, at COMMIT): an opening balance
--    follows the template of its account's class; income, expenses and
--    transfers use asset (bank or cash) accounts only, in this release.
--
-- No table, column, grant, policy or trigger is added or removed, and no row
-- is written: both functions are replaced in place (CREATE OR REPLACE keeps
-- their triggers and privileges; SECURITY DEFINER and search_path are
-- restated because CREATE OR REPLACE resets them).
--
-- Atomicity: like every migration here, `prisma migrate deploy` runs this file
-- as one transaction. Any refusal below rolls back everything in it, and
-- Prisma records the migration as failed (recovery: docs/runbooks/hosted-setup.md,
-- "Credit-card account migrations"). Must not contain BEGIN/COMMIT.
--
-- Forward-only. Existing data is never reclassified or rewritten: if it does
-- not already satisfy the invariant, the migration refuses.

-- 0. Bounded waiting, and no account writes while the rules change.
--    SHARE ROW EXCLUSIVE on financial_accounts blocks inserts, updates and
--    deletes (not reads) until this transaction ends, so nothing can slip
--    between the preflight and the new guard. Fail after 5s rather than
--    queue every other query behind a long-running transaction.
SET LOCAL lock_timeout = '5s';
LOCK TABLE "finora"."financial_accounts" IN SHARE ROW EXCLUSIVE MODE;

-- 1. The mapping. NULL for a type it does not know, which every caller
--    treats as a violation (fail closed when a type is added without it).
CREATE FUNCTION "finora"."financial_account_ledger_kind"(account_type "finora"."financial_account_type")
  RETURNS "finora"."ledger_account_kind"
  LANGUAGE sql
  IMMUTABLE
  SET search_path = ''
AS $$
  SELECT CASE account_type::text
    WHEN 'bank' THEN 'asset'
    WHEN 'cash' THEN 'asset'
    WHEN 'credit_card' THEN 'liability'
  END::finora.ledger_account_kind
$$;

REVOKE ALL ON FUNCTION "finora"."financial_account_ledger_kind"("finora"."financial_account_type") FROM PUBLIC;

-- 2. Preflight: refuse (changing nothing) unless every existing account
--    already has a ledger account of its type's class.
DO $$
DECLARE
  mismatched integer;
BEGIN
  SELECT count(*) INTO mismatched
    FROM "finora"."financial_accounts" AS fa
    JOIN "finora"."ledger_accounts" AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE la.kind IS DISTINCT FROM "finora"."financial_account_ledger_kind"(fa.type);
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'finora: % financial account(s) have a ledger account of the wrong class for their type', mismatched
      -- The hint must not call financial_account_ledger_kind(): this
      -- refusal rolls the migration back, so that function will not exist
      -- when the operator runs the query. An unknown type maps to NULL and
      -- is listed too. Ids, type and kind only (no names).
      USING HINT = 'Nothing was changed. List them with this read-only query: '
                   'SELECT fa.id, fa.owner_id, fa.type, la.kind FROM finora.financial_accounts fa '
                   'JOIN finora.ledger_accounts la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id '
                   'WHERE la.kind::text IS DISTINCT FROM CASE fa.type::text WHEN ''bank'' THEN ''asset'' '
                   'WHEN ''cash'' THEN ''asset'' WHEN ''credit_card'' THEN ''liability'' END ORDER BY fa.owner_id, fa.id; '
                   'Then follow docs/runbooks/hosted-setup.md ("Credit-card account migrations") before changing anything.';
  END IF;
END
$$;

-- 3. Financial accounts -------------------------------------------------------------
-- Backed by a ledger account of the same owner and currency (composite
-- foreign key) and of the class of its type (this check, on INSERT and on a
-- type change). Identity, currency and ledger link never change. Deleting is
-- only possible without any ledger history (and the foreign keys from
-- transactions also restrict it); otherwise archive.
CREATE OR REPLACE FUNCTION "finora"."financial_accounts_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finora.ledger_accounts AS la
       WHERE la.id = NEW.ledger_account_id AND la.owner_id = NEW.owner_id
         AND la.kind = finora.financial_account_ledger_kind(NEW.type)
    ) THEN
      RAISE EXCEPTION 'finora.finance: a financial account must be backed by a ledger account of its type''s class (bank and cash: asset; credit card: liability)'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM finora.journal_lines AS l WHERE l.account_id = OLD.ledger_account_id) THEN
      RAISE EXCEPTION 'finora.finance: an account with ledger history cannot be deleted; archive it instead'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.currency_code <> OLD.currency_code
     OR NEW.ledger_account_id <> OLD.ledger_account_id OR NEW.creation_key <> OLD.creation_key
     OR NEW.creation_fingerprint <> OLD.creation_fingerprint OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'finora.finance: an account''s identity, currency and ledger account are immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The ledger link and the ledger account's kind are immutable, so only a
  -- type change can break the class invariant.
  IF NEW.type IS DISTINCT FROM OLD.type AND NOT EXISTS (
    SELECT 1 FROM finora.ledger_accounts AS la
     WHERE la.id = NEW.ledger_account_id AND la.owner_id = NEW.owner_id
       AND la.kind = finora.financial_account_ledger_kind(NEW.type)
  ) THEN
    RAISE EXCEPTION 'finora.finance: an account''s type cannot change its class (bank and cash are assets, credit cards are liabilities)'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := greatest(now(), OLD.updated_at);
  RETURN NEW;
END;
$$;

-- 4. Transactions: agreement with the ledger, checked at COMMIT -----------------------
-- A transaction must record a posted, non-reversal journal entry whose lines
-- are EXACTLY its posting template (two lines, the right ledger accounts and
-- sides, the transaction's amount):
--   income           Dr destination asset     Cr category income account
--   expense          Dr category expense acct Cr source asset
--   transfer         Dr destination asset     Cr source asset
--   opening_balance  asset account:     Dr account               Cr opening-balance equity
--                    liability account: Dr opening-balance equity Cr account
-- Income, expenses and transfers use asset (bank or cash) accounts only.
-- A void must link the posted reversal of that entry; a replacement must
-- record the entry that replaced the voided original's entry.
CREATE OR REPLACE FUNCTION "finora"."assert_transaction_valid"(target uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  t finora.transactions%ROWTYPE;
  entry finora.journal_entries%ROWTYPE;
  counterpart uuid;
  source_ledger uuid;
  source_kind finora.ledger_account_kind;
  destination_ledger uuid;
  destination_kind finora.ledger_account_kind;
  debit_account uuid;
  credit_account uuid;
  original finora.transactions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM finora.transactions WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO entry FROM finora.journal_entries WHERE id = t.journal_entry_id;
  IF entry.status <> 'posted' OR entry.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'finora.finance: a transaction must record a posted, non-reversal journal entry'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT fa.ledger_account_id, la.kind INTO source_ledger, source_kind
    FROM finora.financial_accounts AS fa
    JOIN finora.ledger_accounts AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE fa.id = t.source_account_id AND fa.owner_id = t.owner_id;
  SELECT fa.ledger_account_id, la.kind INTO destination_ledger, destination_kind
    FROM finora.financial_accounts AS fa
    JOIN finora.ledger_accounts AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE fa.id = t.destination_account_id AND fa.owner_id = t.owner_id;

  IF t.kind IN ('income', 'expense', 'transfer')
     AND ((t.source_account_id IS NOT NULL AND source_kind IS DISTINCT FROM 'asset')
       OR (t.destination_account_id IS NOT NULL AND destination_kind IS DISTINCT FROM 'asset')) THEN
    RAISE EXCEPTION 'finora.finance: income, expenses and transfers use bank and cash accounts only'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.kind IN ('income', 'expense') THEN
    SELECT m.ledger_account_id INTO counterpart FROM finora.category_ledger_accounts AS m
     WHERE m.category_id = t.category_id AND m.owner_id = t.owner_id AND m.currency_code = t.currency_code;
  ELSIF t.kind = 'opening_balance' THEN
    SELECT m.ledger_account_id INTO counterpart FROM finora.system_ledger_accounts AS m
     WHERE m.owner_id = t.owner_id AND m.purpose = 'opening_balance_equity' AND m.currency_code = t.currency_code;
  END IF;

  -- NULL (no template) for anything else, which fails the check below.
  IF t.kind = 'opening_balance' THEN
    debit_account := CASE destination_kind WHEN 'asset' THEN destination_ledger WHEN 'liability' THEN counterpart END;
    credit_account := CASE destination_kind WHEN 'asset' THEN counterpart WHEN 'liability' THEN destination_ledger END;
  ELSE
    debit_account := CASE t.kind WHEN 'expense' THEN counterpart ELSE destination_ledger END;
    credit_account := CASE t.kind WHEN 'income' THEN counterpart ELSE source_ledger END;
  END IF;

  IF debit_account IS NULL OR credit_account IS NULL
     OR (SELECT count(*) FROM finora.journal_lines WHERE entry_id = t.journal_entry_id) <> 2
     OR NOT EXISTS (SELECT 1 FROM finora.journal_lines WHERE entry_id = t.journal_entry_id
                     AND account_id = debit_account AND side = 'debit' AND amount_minor = t.amount_minor)
     OR NOT EXISTS (SELECT 1 FROM finora.journal_lines WHERE entry_id = t.journal_entry_id
                     AND account_id = credit_account AND side = 'credit' AND amount_minor = t.amount_minor) THEN
    RAISE EXCEPTION 'finora.finance: the journal entry does not match the transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.reversal_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finora.journal_entries
     WHERE id = t.reversal_entry_id AND status = 'posted' AND reverses_entry_id = t.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'finora.finance: a void must link the posted reversal of the transaction''s entry'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.replaces_transaction_id IS NOT NULL THEN
    SELECT * INTO original FROM finora.transactions WHERE id = t.replaces_transaction_id;
    IF original.kind <> t.kind OR original.reversal_entry_id IS NULL
       OR entry.replaces_entry_id IS DISTINCT FROM original.journal_entry_id THEN
      RAISE EXCEPTION 'finora.finance: a replacement must record the entry that replaced the voided original'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF t.kind = 'opening_balance' AND (
    SELECT count(*) FROM finora.transactions
     WHERE destination_account_id = t.destination_account_id AND kind = 'opening_balance' AND voided_at IS NULL
  ) > 1 THEN
    RAISE EXCEPTION 'finora.finance: an account can have only one active opening balance'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- CREATE OR REPLACE keeps existing privileges; restated so this file alone
-- shows that PUBLIC cannot call them.
REVOKE ALL ON FUNCTION "finora"."financial_accounts_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "finora"."assert_transaction_valid"(uuid) FROM PUBLIC;

-- 5. Every existing transaction must still satisfy the (replaced) COMMIT-time
--    check. Before credit cards, every account is an asset, for which the
--    templates are unchanged, so this is expected to pass; if it does not,
--    the migration refuses and changes nothing.
DO $$
BEGIN
  PERFORM "finora"."assert_transaction_valid"(t.id) FROM "finora"."transactions" AS t;
END
$$;
