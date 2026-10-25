# Runbook: hosted Supabase setup (not yet performed)

The hosting region is not decided; nothing below assumes one. Do not run
destructive commands against a hosted database.

## 1. Auth settings (dashboard → Authentication), matching `supabase/config.toml`

- Sign-ups: **disabled** ("Allow new users to sign up" off). Keep the email
  provider itself enabled.
- Confirm email: **on**. Secure password change: **on**.
- Minimum password length 12; require lower, upper, digits.
- Site URL: the production origin. Redirect URLs: `<origin>/auth/confirm` only.
- Email templates: copy `supabase/templates/invite.html` and `recovery.html`
  (token-hash links to `{{ .SiteURL }}/auth/confirm`).
- Configure a real SMTP provider (the default sender is rate-limited).
- Anonymous sign-ins and all external providers: off.

## 2. Data API

API settings → exposed schemas: keep `finora` **out** of the list.

## 3. Database

```bash
# In your shell only; never commit these values.
export MIGRATION_DATABASE_URL='postgresql://postgres:…@<direct-host>:5432/postgres?schema=finora'
npm run db:migrate:deploy
```

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

```bash
SUPABASE_URL=… SUPABASE_SECRET_KEY=… MIGRATION_DATABASE_URL=… NEXT_PUBLIC_SITE_URL=https://… \
  npm run owner:provision -- --email owner@example.com
```

## 5. Verify (catalog checks, as `postgres`)

```sql
SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'finora_app'; -- all false
SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'finora'::regnamespace AND relkind = 'r';
SELECT has_schema_privilege('anon', 'finora', 'USAGE'),
       has_schema_privilege('authenticated', 'finora', 'USAGE');                       -- false, false
-- Ledger (Milestone 3): triggers present and enabled ('O'), currencies seeded.
SELECT tgrelid::regclass, tgname, tgenabled FROM pg_trigger
 WHERE tgrelid::regclass::text LIKE 'finora.%' AND NOT tgisinternal ORDER BY 1, 2;     -- 9 rows (incl. owners_set_updated_at), all 'O'
SELECT code, exponent FROM finora.currencies ORDER BY code;                           -- EUR GBP INR JPY KWD USD
SELECT has_table_privilege('finora_app', 'finora.journal_lines', 'UPDATE'),
       has_table_privilege('finora_app', 'finora.journal_entries', 'DELETE');          -- false, false
```

Then sign in as the owner, and confirm a second (non-owner) user is refused.
