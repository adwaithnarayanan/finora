# Runbook: Google sign-in (DEFERRED)

> **Not the current mode.** Finora currently signs in with email and password
> (`owner-access.md`). Use this runbook only when restoring Google OAuth; do
> the code and config steps in ADR 0003 ("Restoring Google OAuth") first. The
> provisioning commands below assume the active method is `google`.

The Google OAuth client belongs to Supabase Auth: the app itself never sees
the client secret. Nothing below has been performed against hosted Supabase
or a real Google project yet.

## 1. Google Cloud (one OAuth client per environment)

In Google Cloud console → **Google Auth Platform**:

1. **Branding / OAuth consent screen**
   - User type: **External**.
   - Publishing status: keep **Testing** and add the owner's Google account
     as the only **test user**. Google then refuses every other account
     before Supabase is involved (a free extra gate). Testing-mode refresh
     tokens from Google are not used by Finora, so this has no downside here.
   - Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
     only.
2. **Clients → Create client → Web application**
   - Authorized JavaScript origins: the app origin, e.g. `https://finora.example`
     (local: `http://localhost:3000`).
   - Authorized redirect URIs: **Supabase's** callback, not the app's:
     - hosted: `https://<project-ref>.supabase.co/auth/v1/callback` (copy it
       from the Supabase Google provider page);
     - local: `http://127.0.0.1:55321/auth/v1/callback`.
3. Copy the client ID and client secret. Store the secret only in Supabase
   (hosted) or in your local root `.env` (local). Never commit either.

## 2. Supabase Auth (hosted dashboard → Authentication)

Match `supabase/config.toml`:

- **Sign In / Providers**
  - Google: **enabled**, with the client ID and secret from step 1.
    "Skip nonce check" off.
  - Email: **disabled**. This refuses password, magic-link/OTP and recovery
    requests.
  - Phone, anonymous sign-ins, SAML SSO, Web3 and every other provider:
    **disabled**.
  - "Allow new users to sign up": **off**.
  - "Allow manual linking": **off**.
- **URL Configuration**
  - Site URL: the production origin.
  - Redirect URLs: exactly `https://<origin>/auth/callback`. No wildcards and
    nothing else.
- Email templates are no longer used by Finora.

Verify from a shell (publishable key only):

```bash
curl -s "https://<project-ref>.supabase.co/auth/v1/settings" -H "apikey: <publishable key>"
# external: only "google": true; "disable_signup": true
```

## 3. Local Google sign-in (optional)

Automated tests do not need real credentials. To try a real Google login
locally:

1. Put the two values in a root `.env`. The Supabase CLI reads it for
   `env()` in `config.toml`; the app doesn't.
   ```
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=...
   SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET=...
   ```
   Without them the local stack still starts, but Google rejects the
   placeholder client.
2. `npm run db:local:stop && npm run db:local:start`
3. `.env.local` for the app as in the README, then `npm run dev`.

## 4. Provision the owner (explicit, never automatic)

Hosted: run each command with `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and
`MIGRATION_DATABASE_URL` supplied in the shell for that command only. Local:
add `--local` instead.

1. **Prepare**: creates a passwordless Supabase user for the owner's Google
   email. It grants nothing.
   ```bash
   npm run owner:provision -- prepare --email owner@gmail.com
   ```
2. **Owner signs in with Google** at `/login` with that exact account.
   Supabase links the Google identity to the prepared user (it must report the
   email as verified). Finora shows **No access**; that is expected.
3. **Complete**: checks that exactly one verified Google identity with the same
   email is linked, records its Google account id as approved, and maps the
   user to a new owner (single-owner rule enforced).
   ```bash
   npm run owner:provision -- complete --email owner@gmail.com
   ```
   It prints the approved Google account id and the owner id.
4. The owner signs in again and reaches the app.

If you stop after step 1, `cancel --email` deletes the unmapped user.

### Existing owner from Milestone 2 (password account)

The owner signs in with Google using the **same email**. Supabase links
Google to the existing user, whose unusable email identity remains. Then run
`complete --email` for that email: the existing mapping is kept, so the owner
id and all data are unchanged, and only the approval is added.

### Changing the owner's Google account (keeps the owner id and all data)

1. `npm run owner:provision -- prepare --relink --email new@gmail.com`
2. The owner signs in with the new Google account (shows **No access**).
3. `npm run owner:provision -- relink --email new@gmail.com`: moves the owner
   mapping to the new user in one transaction. The old user loses access
   immediately (unmapped, approval removed); delete it in the dashboard
   afterwards.

### If access stops unexpectedly

Finora refuses the owner's account when its identities no longer match the
approval. This happens when a second Google account (or another provider) has
been linked to the same Supabase user by email, or when the Google account id
changed. Inspect the user in the dashboard (Authentication → Users →
identities). Remove any identity you don't recognise, then run `complete`
again for the owner's email.

## 5. Manual verification (needs real Google; not automated)

Run these once per environment after setup:

- [ ] `/login` shows only "Continue with Google"; the consent screen names
  the right project.
- [ ] A Google account that is not a test user is refused by Google.
- [ ] A test-user Google account that was not prepared: Finora shows "That
  Google account is not authorised" (Supabase: sign-ups disabled), and no user
  is created in the dashboard.
- [ ] Prepared but not completed: "No access", and refreshing `/` returns to
  sign-in.
- [ ] After `complete`: sign-in lands on `/` (or the `next` path); sign-out
  returns to `/login`, and `/` then redirects to sign-in.
- [ ] `/forgot-password`, `/reset-password` and `/auth/confirm` return 404 for
  the signed-in owner.
- [ ] `curl -X POST "https://<ref>.supabase.co/auth/v1/token?grant_type=password"`
  with the owner's email returns `email_provider_disabled`.
