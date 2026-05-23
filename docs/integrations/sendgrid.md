# SendGrid

_Last verified: 2026-05-23 against commit 4a1d325._

Transactional email — verification emails on signup, password-reset links, account-deletion confirmations. OneStreamer talks to SendGrid via SMTP using `nodemailer`, not via the REST API.

## What gets sent

| Trigger | Subject | Where the code lives |
|---------|---------|----------------------|
| User signs up with email/password | Email verification (with a token link) | `AuthService.signup` → `EmailService.sendVerificationEmail` |
| User requests email re-send | Same verification email | `AuthService.resendVerification` |
| User requests password reset | Password-reset link (24h token) | `AuthService.requestPasswordReset` → `EmailService.sendPasswordResetEmail` |
| User requests account deletion | Confirmation link (24h token) | `AuthService.requestAccountDeletion` → `EmailService.sendAccountDeletionEmail` |
| User restores account during grace period | Restoration confirmation | `EmailService.sendRestorationEmail` |

## Setup

1. Sign up at [sendgrid.com](https://sendgrid.com). Free tier covers low-volume use.
2. **Settings → Sender Authentication** — verify a sending domain (e.g. `onestreamer.live`) by adding the DNS records SendGrid provides. (Or, for quick testing, verify a single sender email.)
3. **Settings → API Keys** → Create API Key:
   - Name: `OneStreamer-Server`
   - Permissions: **Restricted Access** → `Mail Send: Full Access`. Disable everything else.
4. Copy the key (shown ONCE).
5. Set the env vars per the table below.

## Credentials

| Env var | Example | Purpose |
|---------|---------|---------|
| `SMTP_HOST` | `smtp.sendgrid.net` | SMTP server |
| `SMTP_PORT` | `587` | Port (587 for STARTTLS, 465 for SMTPS) |
| `SMTP_USER` | `apikey` | **Literally the string `apikey`** for SendGrid SMTP |
| `SMTP_PASS` | `SG.xxx…` | The SendGrid API key |
| `SMTP_SECURE` | `false` | `false` for STARTTLS on 587, `true` for SMTPS on 465 |
| `FROM_EMAIL` | `noreply@onestreamer.live` | Sender address — must match a verified domain/sender |

## Fallback behavior (no SMTP configured)

If `SMTP_HOST` is unset, [`EmailService`](../../server/services/EmailService.js) **logs emails to stdout** instead of sending them. Useful in dev (you can copy the verification link from `pm2 logs onestreamer-server` and visit it yourself); broken in production because users will never get their emails.

```
📧 Verification email for user@example.com: https://onestreamer.live/verify-email/abc123...
```

## Code paths

| Concern | File |
|---------|------|
| Email sending | [`server/services/EmailService.js`](../../server/services/EmailService.js) |
| Auth triggers | [`server/services/AuthService.js`](../../server/services/AuthService.js) |
| Account deletion trigger | [`server/services/AccountService.js`](../../server/services/AccountService.js) (via AuthService) |
| nodemailer config | inside `EmailService.js` |

## Operational notes

- **`SMTP_USER` is literally the string `apikey`** for SendGrid SMTP. This is a SendGrid convention — the actual key goes in `SMTP_PASS`. Other SMTP providers (Gmail, Mailgun, etc.) use real usernames.
- **Sender authentication matters.** If `FROM_EMAIL`'s domain isn't verified in SendGrid, emails will either land in spam or be rejected outright.
- **Free tier limits** — SendGrid's free tier is enough for OneStreamer's transactional volume in early days, but be aware of the cap (~100 emails/day on free tier as of writing).
- **Bounces and complaints** matter for deliverability. Check the SendGrid dashboard periodically for users marking emails as spam — that hurts sender reputation.
- **The committed `config/ecosystem.config.js` historically included the real SendGrid API key as an environment value.** That key should be rotated and removed from the committed file. See [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md).

## Alternatives

If you'd rather not use SendGrid, the configuration is just SMTP — anything that speaks SMTP works:

- **Mailgun** — `smtp.mailgun.org:587`, your domain's SMTP credentials
- **AWS SES** — `email-smtp.<region>.amazonaws.com:587`, IAM-generated SMTP credentials
- **Postmark** — `smtp.postmarkapp.com:587`, server-token SMTP password
- **Gmail SMTP** — works but capped at ~500 sends/day and requires an app password; not recommended for transactional

Update `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` accordingly.

## Verifying connectivity

```bash
# Quick test from the host
nc -zv smtp.sendgrid.net 587
# Should print "Connection succeeded"

# Force a verification email to a test address (after creating the user)
curl -X POST https://onestreamer.live/auth/resend-verification \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <user-jwt>" \
  -d '{}'

# Watch for SendGrid logs
pm2 logs onestreamer-server | grep -iE "(sendgrid|email|smtp)"
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No verification email arrives | Confirm `SMTP_HOST` etc. are set; check `pm2 logs` for SendGrid errors; verify `FROM_EMAIL` domain is authenticated; check spam folder; check SendGrid dashboard "Activity" log |
| `Invalid login` / `535 Authentication failed` | `SMTP_USER` must be `apikey` (literal string), `SMTP_PASS` is the API key. Common mistake: setting `SMTP_USER` to your SendGrid email. |
| Emails arriving in spam | Verify the sending domain in SendGrid (SPF, DKIM, DMARC records). Anonymous-domain emails get spam-foldered. |
| `Daily sending limit exceeded` | Free tier cap. Upgrade SendGrid plan or switch to a different SMTP provider. |
| All emails sent but users complain they didn't get them | Check the SendGrid Activity Log — was the email delivered? Bounced? Marked spam? Provides per-recipient delivery state. |

## See also

- [`/docs/security/auth-flows.md`](../security/auth-flows.md) — when verification + password-reset emails are sent
- [`/docs/features/admin-panel.md#account-deletion-cross-cutting-feature`](../features/admin-panel.md) — account-deletion confirmation flow
- [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md) — how to rotate the SendGrid key
- [SendGrid SMTP docs](https://docs.sendgrid.com/for-developers/sending-email/integrating-with-the-smtp-api)
