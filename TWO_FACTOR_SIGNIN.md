# Two-Factor Sign-In (emailed one-time code)

**Added 19 Oct 2026 — branch `feat/login-2fa-email-otp`, off `main`.**

A correct email and password no longer opens a session on their own. The system
emails a 6-digit code and asks for it. Someone holding a stolen or guessed
password still cannot sign in unless they can also read that person's email.

Ships **off**. An administrator switches it on from System Settings → Security,
or from the server with `npm run two-factor -- on`. See *Rolling it out* below.

---

## The shape of it

```
POST /api/auth/login          email + password
                              ├─ 2FA off, or role out of scope → { token, user }   (unchanged)
                              └─ 2FA on → 401 { code: 'OTP_REQUIRED', challengeId, maskedEmail }
                                          and a code is emailed

POST /api/auth/verify-otp     challengeId + code → { token, user }
POST /api/auth/resend-otp     challengeId        → a new code, same challenge
```

| Where | What |
|---|---|
| `utils/loginOtp.js` | the rules: code generation, hashing, expiry, who is in scope, the `Setting`-backed config. **No DB work beyond reading config.** |
| `services/loginOtp.js` | the row work: issue / verify / resend, the sweep, and `readiness()` |
| `models/LoginOtp.js` + `migrations/20261019000001-create-login-otps.js` | one short-lived row per sign-in in progress |
| `utils/emailService.js` | `sendLoginOtpEmail` — and `deliver()`, which **throws** (see below) |
| `controllers/authController.js` | `completeLogin` / `login` / `verifyOtp` / `resendOtp` |
| `controllers/settingsController.js`, `routes/settings.js` | `GET`/`PUT /api/settings/two-factor` |
| `scripts/two-factor.js` | `status` / `on` / `off` from the server — the break-glass |
| `tests/loginOtp.test.js` | 40 tests, pure functions, no database |

Frontend: `components/auth/OtpStep.jsx` (one component, used by both the login
page and the HR tap page), `services/otpChallenge.js`, and
`components/admin/settings/TwoFactorSettingsTab.jsx`.

---

## Decisions, and why

**No token is issued before the code is accepted — not even a restricted one.**
`middleware/auth.js` admits any JWT signed with `JWT_SECRET` and re-reads role
and permissions from the row. A "pending" token would therefore be a working
session on every route in the system unless that middleware learned to refuse
it. An opaque `challengeId` cannot be mistaken for a session by anything.

**The code hash covers `${challengeId}:${code}`, not the code alone.** Six
digits is a million possibilities; a bare SHA-256 of the code is reversible by
anyone with the table. `challengeId` is 32 random bytes, so it salts the hash
and a copy of this table is not a list of live codes. What actually stops online
guessing is the per-challenge attempt cap, which no IP rotation escapes.

**The OTP email throws when it cannot be sent; every other email swallows.**
`sendEmail()` logs and continues, which is right for a welcome email — it must
not undo the account it announces. A code is the opposite: it is the thing the
user is waiting for. Swallowing that failure gives a code box with no code
coming and a server reporting success. `deliver()` is the throwing door;
`sendLoginOtpEmail` uses it, and the login route answers 503. **A mail outage
refuses the sign-in rather than waving it through** — an outage is exactly when
an attacker with a stolen password would most like the second factor skipped.

**The config read fails open; the send fails closed.** If the `Setting` rows
cannot be read (a DB blip) the policy reads as off, matching
`utils/passwordRotation.js` and for the same reason: a hiccup in one table must
not lock a live clinic out. The password is still checked, so this degrades the
second factor rather than authentication.

**An account with no address is in scope and refused, not exempted.** If
`appliesTo()` returned false for a missing email, clearing the email field would
be a way to switch two-factor off for that account — and the accounts with no
address are the stale ones most worth protecting.

**Reserved domains are data, not a regex.** `readiness()` has to find these
accounts in SQL, and a `WHERE` clause cannot run a JavaScript regex. So
`RESERVED_DOMAINS` is a list, and both the regex and the `LIKE` patterns are
derived from it. Written as two hand-kept copies they would disagree the first
time somebody added a domain, and the side that silently stopped matching would
be the database one — the settings page would report everybody reachable and the
lockout would land at sign-in. `tests/loginOtp.test.js` compares the two rules
over real addresses.

**Remembered phones (HR tap) do not ask for a code,** because the device token
*is* a second factor. But a device token is only ever minted after a code has
been accepted: `rememberDevice` is recorded on the challenge at the **password**
step and read back at verify, so the verify request cannot ask to be remembered
when the login request did not.

**Patients are out of scope.** Their portal reaches one person's own record, not
the clinic's; many patient accounts share a family address or have none; and
locking a diabetic out of their glucose history because a relay is down is a
different kind of harm from making a clerk wait.

---

## Rolling it out

The migration only adds a table, and nothing reads it until the policy is on, so
**deploying is not the same as enabling.** Do them separately.

```bash
# 1. deploy + migrate (adds LoginOtps; changes no behaviour)
npm run migrate

# 2. look before you leap — who could NOT receive a code?
npm run two-factor -- status

# 3. fix anybody listed, then switch it on
npm run two-factor -- on

# 4. sign in once, for real, and watch the code arrive

# if anything is wrong:
npm run two-factor -- off      # live within 30 seconds, no restart, no redeploy
```

Step 2 is the one that matters. `status` names every in-scope account that
cannot receive a code and separates:

- **a new lockout** — an address at a domain that cannot receive mail. These
  people can sign in today and will not be able to afterwards.
- **already unreachable** — no address at all. These accounts cannot sign in
  today either (`POST /auth/login` finds the account *by* the address it is
  given), so this feature takes nothing from them.

It also prints a breakdown by domain, because the automatic check only catches
provable placeholders (`example.com`, `.test`, `.invalid`). It cannot know that
one real domain is the clinic's mailbox and another is a leftover. **A human
reading that list is the check that works.** On the dev dump, four in-scope
accounts sit on `@cdc.com` while the clinic's mail is `@cdiabetescentre.com`,
and one administrator is on `@westlands.example.com` — `scripts/set-password.js`
exists precisely because "the admin has no real mailbox".

Why the CLI exists at all: the settings screen needs you to sign in, and the one
emergency that matters here is *nobody can sign in*.

---

## Deliberately not done

- **Authenticator apps (TOTP).** Email was asked for and is what every member of
  staff already has. TOTP would need enrolment, QR codes and recovery codes.
- **Trusted-device "don't ask for 30 days" on the main login.** The HR tap page
  has this because a tag URL always lands logged out; the portal does not, and
  adding it would blunt the feature on the sessions that matter most.
- **Per-role scope in the UI.** `TWO_FACTOR_ROLES` is `INTERNAL_ROLES`. If this
  needs to differ per role, that list is the only thing to change.
- **Consolidating the `Setting`-cache pattern.** `utils/loginOtp.js`,
  `passwordRotation.js`, `hrConfig.js`, `labInboxConfig.js` and `commsConfig.js`
  now all carry the same cached-read-with-defaults shape. It wants one shared
  `settingStore` helper — a worthwhile tidy-up, and the wrong thing to attempt
  in the same change as a security feature going to a live clinic.

## Porting to `feat/multi-tenancy`

Built on `main`, so there is no `clinicId` anywhere in it. The retrofit is
mechanical and small by design:

1. add `'LoginOtp'` to `TENANT_OWNED` in `constants/tenancy.js`
2. add `'LoginOtp.challengeId'` to `UNIQUE_NOT_CLINIC_SCOPED` — 32 random bytes,
   unique platform-wide, same reasoning as `UserDevice.tokenHash`
3. wrap the verify and resend paths in `beforeClinicKnown(...)`, as
   `resetPassword` already is — the challenge id identifies one row platform-wide
4. `login` already runs inside `runWithClinic`, so issuing needs no change

The challenge row is keyed on `UserId`, never on email, specifically so that
step 3 is all that is needed once email stops being globally unique.
