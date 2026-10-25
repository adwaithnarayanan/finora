-- Credit cards (docs/adr/0008-credit-card-accounts.md), step 1 of 2: the enum
-- value only. PostgreSQL refuses to use a newly added enum value in the
-- transaction that added it, and `prisma migrate deploy` runs each migration
-- file as one transaction, so everything that depends on 'credit_card' is in
-- the next migration (20261025000700_account_ledger_class).
--
-- Forward-only: an enum value cannot be dropped. Unused, it changes nothing:
-- the old guard still requires an asset ledger account for every financial
-- account, so no credit card can be created until the next migration lands.

-- AlterEnum
ALTER TYPE "finora"."financial_account_type" ADD VALUE 'credit_card';
