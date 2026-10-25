# Runbook: hosted Supabase setup (not yet performed)

The hosting region is not decided; nothing below assumes one. Do not run
destructive commands against a hosted database.

## 1. Auth settings (dashboard → Authentication), matching `supabase/config.toml`

Current mode is email/password: follow `docs/runbooks/owner-access.md`
section 5. In short, Email is on, sign-ups are off, and every other provider is
off. Use the neutral email templates, OTP length 10 and empty Redirect URLs.
(Google is deferred; see `docs/runbooks/google-oauth.md` when restoring it.)

## 2. Data API

API settings → exposed schemas: keep `finora` **out** of the list.

## 3. Database

```bash
# In your shell only; never commit these values.
export MIGRATION_DATABASE_URL='postgresql://postgres:…@<direct-host>:5432/postgres?schema=finora'
npm run db:migrate:deploy
```

If `20261025000400_account_name_case_insensitive` fails with "account names
differ only by letter case", nothing was changed. Run the hint query from the
error, rename the affected accounts in the app (or with the owner's
agreement), then mark the failed attempt rolled back and deploy again:
`npx prisma migrate resolve --rolled-back 20261025000400_account_name_case_insensitive && npm run db:migrate:deploy`.

Set the runtime role's login password (generate a long random value; store it
only in the hosting provider's secret settings):

```sql
ALTER ROLE finora_app WITH LOGIN PASSWORD '<generated>';
```

App environment (hosting provider settings): `NEXT_PUBLIC_SITE_URL`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (Supavisor
transaction pooler, user `finora_app.<project-ref>`, port 6543), optionally
`DATABASE_POOL_MAX`. Never `SUPABASE_SECRET_KEY` or `MIGRATION_DATABASE_URL`.

## 4. Owner

Explicit three-step provisioning (prepare, set-password, complete):
`docs/runbooks/owner-access.md` section 1. Supply
`SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `MIGRATION_DATABASE_URL` in the shell
for each command only.

## 5. Verify (catalog checks, as `postgres`)

```sql
SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'finora_app'; -- all false
SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'finora'::regnamespace AND relkind = 'r';
SELECT has_schema_privilege('anon', 'finora', 'USAGE'),
       has_schema_privilege('authenticated', 'finora', 'USAGE');                       -- false, false
-- Ledger (Milestone 3): triggers present and enabled ('O'), currencies seeded.
SELECT tgrelid::regclass, tgname, tgenabled FROM pg_trigger
 WHERE tgrelid::regclass::text LIKE 'finora.%' AND NOT tgisinternal ORDER BY 1, 2;     -- 17 rows (ledger, finance and owners_set_updated_at), all 'O'
SELECT code, exponent FROM finora.currencies ORDER BY code;                           -- EUR GBP INR JPY KWD USD
SELECT has_table_privilege('finora_app', 'finora.journal_lines', 'UPDATE'),
       has_table_privilege('finora_app', 'finora.journal_entries', 'DELETE');          -- false, false
```

Then work through the manual checklist in `docs/runbooks/owner-access.md`
section 6.
