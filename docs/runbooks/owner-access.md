# Runbook: owner access (email/password, current mode)

Finora currently signs in with email and password only (ADR 0003). Google
OAuth is deferred; see `google-oauth.md` and the "Restoring Google OAuth"
section of ADR 0003. Nothing below has been performed against hosted Supabase.

All commands take `--local` for the local stack. For a hosted project, supply
`SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `MIGRATION_DATABASE_URL` in the shell
for that one command only. Never store them in a file.

## 1. Provision the owner (explicit; a login never grants access)

```bash
npm run owner:provision -- prepare      --email owner@example.com
npm run owner:provision -- set-password --email owner@example.com
npm run owner:provision -- complete     --email owner@example.com
```

1. `prepare` creates a passwordless, email-confirmed Supabase user. It grants
   nothing, and it refuses if an owner already exists.
2. `set-password` prompts twice with input hidden.
   - The password must be at least 12 characters and at most 72 bytes, and
     include upper- and lower-case letters and a digit.
   - It is never printed. Never pass it as an argument or put it in an env
     var or file.
   - For automation, pipe it in: `<password-manager-cli> | npm run owner:provision -- set-password --email … --password-stdin`.
     Avoid `echo`, which leaves the password in shell history.
3. `complete` approves that confirmed email for password sign-in and maps the
   user to the owner (single-owner rule enforced). It refuses until
   `set-password` has run.

If you stop after `prepare`, `cancel --email` deletes the unmapped user.

## 2. Sign in locally

```bash
npm run db:local:start && npm run db:local:setup
npm run owner:provision -- prepare      --local --email you@example.com
npm run owner:provision -- set-password --local --email you@example.com
npm run owner:provision -- complete     --local --email you@example.com
npm run dev    # with .env.local as in the README; open http://localhost:3000
```

## 3. Rotate (or reset) the password

```bash
npm run owner:provision -- set-password --email owner@example.com
```

This also ends every session for that user on every device. There is no
self-service reset by email: recovery and magic-link emails deliberately
contain no link or code.

## 4. Change the owner's account (keeps the owner id and all data)

```bash
npm run owner:provision -- prepare --relink --email new@example.com
npm run owner:provision -- set-password     --email new@example.com
npm run owner:provision -- relink           --email new@example.com
```

The old user loses access immediately (unmapped, approvals removed). Delete it
in the dashboard afterwards.

## 5. Hosted Supabase settings (manual; not automated or verified)

Dashboard → Authentication, matching `supabase/config.toml`:

- **Sign In / Providers**
  - Email: **enabled**.
  - "Confirm email": **on**.
  - "Secure password change": **on**.
  - "Allow new users to sign up": **off**.
  - Google, every other provider, phone, anonymous sign-ins, SAML SSO and
    Web3: **off**.
  - Manual linking: **off**.
- **Password policy:** minimum length 12; require lower case, upper case and
  digits. Enable leaked-password protection if your plan offers it.
- **Email OTP:** length 10 (the maximum), expiry 300 seconds.
- **Email templates:** set Recovery, Magic Link, Invite and Confirm signup to
  the content of `supabase/templates/no-email-sign-in.html`. It must not
  contain any `{{ .ConfirmationURL }}`, `{{ .Token }}` or `{{ .TokenHash }}`.
- **URL configuration:** Site URL is the production origin; Redirect URLs is
  empty.
- **SMTP:** configure an SMTP provider if you want the neutral notices
  delivered at all. Nothing depends on them.

Check with the publishable key:

```bash
curl -s "https://<project-ref>.supabase.co/auth/v1/settings" -H "apikey: <publishable key>"
# external: only "email": true; "disable_signup": true; "mailer_autoconfirm": false
```

## 6. Manual verification checklist (per environment)

- [ ] `/login` shows only email and password fields.
- [ ] A wrong password, an unknown email and an unconfirmed user all show
  "Invalid email or password."
- [ ] After `prepare` and `set-password` but before `complete`: sign-in
  shows "No access", and `/` returns to sign-in.
- [ ] After `complete`: sign-in reaches `/` (or the `next` path); sign-out
  returns to `/login`.
- [ ] Request a password reset for the owner's email from the Supabase API:
  the email that arrives contains no link or code.
- [ ] `/auth/callback`, `/forgot-password` and `/reset-password` return 404.
