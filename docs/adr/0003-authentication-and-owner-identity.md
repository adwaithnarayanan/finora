# ADR 0003: Authentication and owner identity

- Status: Accepted. Revised: Milestone 4A made sign-in Google-only. A later
  change made **email/password the current method, with Google deferred**.
- Date: 2026-10-25

## Context

Finora is private and single-owner. Its data model must support more owners
later and must not be tied to one auth provider. Supabase Auth is the chosen
provider; `@supabase/auth-helpers-nextjs` is deprecated.

Google OAuth was causing login problems. Email/password was therefore
restored as the single sign-in method so development can continue. The
change is designed to be reversible.

## Decision

**Identity vs owner.** Supabase identifies a user by `auth.users.id` (the JWT
`sub`). Finora never uses that as its own key:
- `finora.owners.id` is an application UUID.
- `finora.owner_identities` maps `(provider, subject)` to an owner. It is
  unique per `(provider, subject)` and per `(owner, provider)`; the subject is
  the Supabase user id.
- Every owner-scoped table references `owners.id`.

Changing the sign-in method never changes this mapping.

**Adapter boundary.**
- `src/server/auth/types.ts` defines provider-neutral ports
  (`IdentityProvider`, `OwnerDirectory`).
- `authorizeOwner()` in `authorize.ts` is pure and unit-tested with fakes.
- Supabase code lives only in `src/server/auth/supabase/` and `src/proxy.ts`
  (ESLint-enforced).
- The sign-in method is chosen by one code constant, `ACTIVE_SIGN_IN_METHOD`
  in `src/server/auth/supabase/sign-in-method.ts`. It is currently
  `"password"`. Because it is code rather than configuration, it can't be
  changed at runtime.

**Exactly one sign-in method at a time.** There is no combined login screen.
- **Email/password (current):** the email provider is on. Google and every
  other provider are off.
- **Google (deferred):** Google is on and the email provider is off.

**Verified behaviour of the installed Supabase Auth (v2.197.0).** Checked with
local tests and source:
- **Sign-ups:** `[auth] enable_signup = false` blocks registration
  (`signup_disabled`), including OTP sign-up. It does **not** block password
  sign-in for existing users. In the CLI, `[auth.email] enable_signup` toggles
  the email *provider*, not registration.
- **Errors that reveal state:** an unconfirmed email returns
  `email_not_confirmed`, which differs from `invalid_credentials`. The app
  shows one generic message for both. A wrong password, an unknown email and
  a user without a password all return `invalid_credentials`.
- **Email links:** magic-link/OTP and recovery requests are still accepted
  for existing users while the email provider is on. Admin-generated links
  (secret key only) still mint sessions. Neither kind of session records
  `password` in `amr`.
- **Google:** with sign-ups off, a Google login for an unknown email is
  refused. A verified Google email that matches an existing user is linked to
  that user automatically.
- **Admin password change:** an admin password change deletes all of the
  user's sessions. `GET /user`, which is behind `getUser()`, refuses tokens
  whose session is gone (`session_not_found`).
- **Passwordless users:** the Auth server stores a random password hash for
  them, so "has a password" can't be read from `auth.users`.

**Verification (every protected request).** The Supabase adapter
(`src/server/auth/supabase/identity.ts`) applies the active `SignInPolicy`:
1. `getClaims()` verifies the token's signature and expiry; `getSession()` is
   never used for identity. The policy then requires:
   - `role = authenticated` and a non-anonymous user;
   - an `amr` entry for the active method: `password` (current) or `oauth`
     (Google).

   Sessions from OTP, magic, recovery or invite links, from OAuth while in
   password mode, or from passkeys are refused.
2. `getUser()` loads the user from the Auth server: authoritative
   `app_metadata` and identities, and it rejects revoked sessions whose JWT
   hasn't expired.
3. The operator's approval must hold:
   - **Password:** the user's confirmed email equals
     `app_metadata.finora_password_email`, and an email identity exists. A
     changed email or a withdrawn approval is refused.
   - **Google:** the user's only sign-in identity is the verified Google
     account whose id equals `app_metadata.finora_google_id`.

   `app_metadata` can be written only with the secret key.

The resulting identity (`supabase`, user id) goes to `authorizeOwner()`. With
no identity the visitor goes to `/login`. Without an active owner mapping
(unmapped, or `disabled_at` set) they go to `/unauthorized`.

**Authorisation (fail closed).**
- `requireOwner()` (`src/server/auth/session.ts`) is the Data Access Layer.
  Every protected page, server action and data access calls it.
- `proxy.ts` only refreshes cookies and does an optimistic redirect.
- `requireOwner()` returns a branded `AuthorizedOwner`. That is the only input
  `withOwnerScope()` accepts, so an owner id from the browser can never reach
  the database.

**Provisioning (explicit; a login never creates or authorises an owner).**
Run by an operator with `npm run owner:provision` (`scripts/lib/provisioning.mjs`),
using the secret key and the privileged database connection:
1. **`prepare --email`** creates a passwordless, email-confirmed user. The
   operator vouches for the address, and Finora sends no confirmation links.
   Nothing is approved or mapped yet. It refuses if an owner already exists.
2. **`set-password --email`** reads the password from a hidden terminal
   prompt (entered twice) or from piped stdin with `--password-stdin`.
   - It never accepts the password as an argument or environment variable,
     and never prints it.
   - The password is validated (≥12 characters, ≤72 bytes, upper and lower
     case and a digit; Supabase enforces the same policy).
   - It records `app_metadata.finora_password_set_at` and ends every session
     of that user. Running it again rotates the password.
3. **`complete --email`** requires a confirmed email and a password set by
   `set-password`. It records the approved email, then maps the user to a new
   owner in one transaction. The single-owner rule is re-checked under a lock.
   - If mapping fails, the approval is withdrawn.
   - Neither an approval without a mapping nor a mapping without an approval
     grants anything.
   - Running it for an already-mapped user approves that user for the active
     method and keeps the owner. This is how an owner moves between methods
     without losing data.

Other commands:
- **`relink --email`** moves the existing owner to another prepared user by
  updating the mapping's subject. The owner id and all financial data stay
  the same, and the old user loses access at once.
- **`cancel --email`** deletes a prepared user that was never mapped.
- A second owner requires `--allow-additional`.

**Emails that could sign someone in are neutralised.** The recovery,
magic-link, invite and confirmation templates
(`supabase/templates/no-email-sign-in.html`) contain no link, token or code.
- Supabase still issues an unsent code for OTP and recovery requests. It is 10
  digits long (`otp_length = 10`, the maximum) and expires after 5 minutes,
  and verification is rate-limited, so guessing it isn't practical.
- Password reset by email is therefore unavailable. The operator sets or
  rotates the password instead.

**Flows (password mode).**
- **Sign-in:** `/login` posts to the `signIn` server action:
  - Zod validates the input, and `signInWithPassword` signs in.
  - Every refusal shows "Invalid email or password." Only rate limiting
    (`429`) gets a different message.
  - A session that fails authorisation is signed out at once and sent to
    `/unauthorized`.
- **Redirects:** `next` must pass `safeNextPath()`, which allows only
  same-origin paths and rejects `//`, backslashes, control characters and
  absolute URLs.
- **Sign-out:** a POST-only server action (`scope: local`).
- **Google (deferred):** the code stays, isolated and inert:
  - `GET /auth/callback` returns 404 before touching any code or cookie.
  - `signInWithGoogle` refuses to run unless the active method is `google`,
    and nothing renders it.
  - Even a valid OAuth session is refused by the password policy (tested).

**Secrets.**
- The app holds only the publishable key; `parseAuthEnv` rejects a secret or
  service-role key.
- The secret key and the migration database URL are used only by the
  provisioning script and test fixtures.
- Owner passwords exist only in Supabase Auth, as bcrypt hashes.

## Restoring Google OAuth (future milestone)

1. Set `ACTIVE_SIGN_IN_METHOD = "google"` in
   `src/server/auth/supabase/sign-in-method.ts` and in
   `scripts/lib/provisioning.mjs` (a test checks they match).
2. Login page: render `src/features/auth/google/google-sign-in-button.tsx`
   instead of `LoginForm`, and remove the password `signIn` action.
3. Add `/auth/callback` to `additional_redirect_urls` in `supabase/config.toml`.
4. Set `[auth.external.google] enabled = true` and `[auth.email]
   enable_signup = false` in the same file.
5. Follow `docs/runbooks/google-oauth.md` for the Google Cloud client and the
   Supabase dashboard.
6. For the owner: they sign in with Google using the same email (Supabase
   links it), then run `complete --email`. The owner id and all data are kept.
7. Restore the Google e2e tests from the Milestone 4A version of
   `tests/e2e/auth.spec.ts`.

## Deferred

- Mandatory TOTP MFA, which belongs in a dedicated security milestone. The AAL
  claim is available from `getClaims()` when it is needed.
- Self-service password reset (it needs a secure recovery flow and a real
  SMTP provider).
- Rate limiting beyond Supabase Auth's built-in limits, CAPTCHA, CSP headers,
  and leaked-password protection (hosted, plan-dependent).

## Consequences

- **Instant revocation:** setting `disabled_at` revokes owner access at once,
  independent of outstanding JWTs.
- **Cost per request:** each protected request makes one Auth API call
  (`getUser`) plus one identity lookup transaction. That's acceptable for one
  owner, and it makes revocation take effect immediately. Revocation covers
  sign-out, password rotation, a withdrawn approval and a changed email.
- **Lockout risk:** a forgotten password needs the operator, who runs
  `set-password`. There is no email recovery.
- **Hosted configuration:** the hosted project must be configured to match
  `supabase/config.toml` by hand (`docs/runbooks/owner-access.md`). The
  integration tests verify only the local configuration.
