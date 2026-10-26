-- Credit cards (docs/adr/0008-credit-card-accounts.md), Milestone 5B: an
-- expense may be paid by a credit card.
--
--  * assert_transaction_valid (deferred, at COMMIT): the source of an expense
--    may now be a credit card, that is, an account of type credit_card backed
--    by a liability ledger account. The posting template is unchanged
--    (Dr category expense account / Cr source account), so for a card the
--    credit increases the amount owed. Income and transfers still use asset
--    (bank or cash) accounts only, on both sides.
--
-- This only relaxes one rule: every transaction valid before this migration
-- is still valid after it, so existing rows are not re-checked. Nothing else
-- in the function changes (diff against 20261025000700_account_ledger_class).
-- No table, column, enum value, grant, policy or trigger is added or removed,
-- and no row is written. The function stays SECURITY INVOKER (it runs inside
-- the SECURITY DEFINER trigger function transactions_validate), with the
-- fixed empty search_path restated because CREATE OR REPLACE resets it.
--
-- Forward-only. Must not contain BEGIN/COMMIT (`prisma migrate deploy` runs
-- the file as one transaction).

-- Transactions: agreement with the ledger, checked at COMMIT -----------------------
-- A transaction must record a posted, non-reversal journal entry whose lines
-- are EXACTLY its posting template (two lines, the right ledger accounts and
-- sides, the transaction's amount):
--   income           Dr destination asset     Cr category income account
--   expense          Dr category expense acct Cr source (asset, or credit-card liability)
--   transfer         Dr destination asset     Cr source asset
--   opening_balance  asset account:     Dr account               Cr opening-balance equity
--                    liability account: Dr opening-balance equity Cr account
-- A credit card can be the source of an expense; income and transfers use
-- asset (bank or cash) accounts only.
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
  source_type finora.financial_account_type;
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

  SELECT fa.ledger_account_id, la.kind, fa.type INTO source_ledger, source_kind, source_type
    FROM finora.financial_accounts AS fa
    JOIN finora.ledger_accounts AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE fa.id = t.source_account_id AND fa.owner_id = t.owner_id;
  SELECT fa.ledger_account_id, la.kind INTO destination_ledger, destination_kind
    FROM finora.financial_accounts AS fa
    JOIN finora.ledger_accounts AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE fa.id = t.destination_account_id AND fa.owner_id = t.owner_id;

  -- Asset accounts everywhere, except that the source of an expense may be a
  -- credit card (both its type and its liability ledger account are checked).
  IF t.kind IN ('income', 'expense', 'transfer')
     AND ((t.source_account_id IS NOT NULL AND source_kind IS DISTINCT FROM 'asset'
           AND NOT (t.kind = 'expense' AND source_kind = 'liability' AND source_type = 'credit_card'))
       OR (t.destination_account_id IS NOT NULL AND destination_kind IS DISTINCT FROM 'asset')) THEN
    RAISE EXCEPTION 'finora.finance: a credit card can only pay an expense; income and transfers use bank and cash accounts only'
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
-- shows that PUBLIC cannot call it.
REVOKE ALL ON FUNCTION "finora"."assert_transaction_valid"(uuid) FROM PUBLIC;
