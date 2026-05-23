# Google OAuth

_Last verified: 2026-05-23 against commit 4a1d325._

Sign-in via Google. Uses [`passport-google-oauth20`](https://www.passportjs.org/packages/passport-google-oauth20/) for the OAuth 2.0 dance. Returning users auto-login; new users get a follow-up username-selection step.

## What it gives users

- Skip the email/password signup form
- One-click sign-in for return visits
- Verified email implicit from Google (no separate email-verify step needed)

## Flow

```
1. User clicks "Sign in with Google"
2. Browser → GET /auth/google (main server)
3. Server (passport) → redirect to https://accounts.google.com/o/oauth2/v2/auth?...
4. User consents in Google
5. Google → GET /auth/google/callback?code=...&state=...
6. Server exchanges code for token; fetches user profile (email, name, picture)
7. Server checks if user exists by google_id:
   - exists → issue OneStreamer JWT, redirect to /auth/success?token=...&refreshToken=...
   - new   → store partial signup state, redirect to /auth/complete-registration
8. Client OAuthCallback.tsx parses the URL params, stores tokens, lands user on the home page
```

## Credentials

| Env var | Purpose |
|---------|---------|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |
| `CLIENT_URL` | Used to construct the callback URL (`${CLIENT_URL}/auth/google/callback`) |

## Setting up a Google OAuth client

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select one).
3. **APIs & Services → OAuth consent screen**:
   - User Type: External (unless you're in a Workspace org and want internal-only)
   - App name: `OneStreamer`
   - User support email: your email
   - Authorized domains: `onestreamer.live` (or your domain)
   - Scopes: `email` and `profile` (the default scopes — that's all OneStreamer asks for)
4. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**:
   - Application type: **Web application**
   - Name: `OneStreamer Server`
   - Authorized JavaScript origins: `https://onestreamer.live` (and `https://localhost:3443` for local dev if you want to test locally)
   - **Authorized redirect URIs**: `https://onestreamer.live/auth/google/callback` (and `https://localhost:3443/auth/google/callback` for dev)
5. Copy the **Client ID** and **Client Secret**.
6. Set the env vars per the table above.

## Code paths

| Concern | File |
|---------|------|
| Passport strategy registration | [`server/services/AuthService.js`](../../server/services/AuthService.js) |
| OAuth routes | [`server/routes/auth.js`](../../server/routes/auth.js) — `GET /auth/google`, `GET /auth/google/callback` |
| Token issuance after OAuth success | `AuthService.generateToken()` |
| New-user username selection | [`client/src/components/auth/OAuthUsernameSelection.tsx`](../../client/src/components/auth/OAuthUsernameSelection.tsx) |
| OAuth callback handler in React | [`client/src/components/auth/OAuthCallback.tsx`](../../client/src/components/auth/OAuthCallback.tsx) |

## Scopes

OneStreamer asks for the default Passport scopes only:

- `profile` — basic profile info (name, picture)
- `email` — primary email address

No need for Calendar, Drive, Gmail, etc. The OAuth consent screen will show only these.

## OAuth callback URLs

| Environment | Callback URL |
|-------------|--------------|
| Production | `https://onestreamer.live/auth/google/callback` |
| Local dev | `https://localhost:3443/auth/google/callback` |

These must match the **Authorized redirect URIs** in the Google OAuth client config exactly (down to the protocol and trailing slash). If they don't match, Google rejects the OAuth flow with `redirect_uri_mismatch`.

## Operational notes

- **Email is implicitly verified** by Google. Users who sign up via Google skip the email-verify-token-link step that email/password users go through.
- **Account merging** — if a user signs up with email/password, then later signs in with Google using the same email, OneStreamer doesn't currently merge the accounts. They'd have two separate user rows. (Not currently a documented bug; capture as a follow-up if you care.)
- **Username collision** — when a new Google user's preferred username (often derived from the email local-part) collides with an existing username, the user is sent to `/auth/complete-registration` to pick one manually.
- **Tokens** — Google access tokens are not stored. Only the OneStreamer-issued JWT + refresh token persists in the browser.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `redirect_uri_mismatch` | Authorized redirect URIs in Google console don't match `CLIENT_URL` + `/auth/google/callback`. Check protocol (`https` vs `http`), domain, trailing slash. |
| "OAuth client was not found" | `GOOGLE_CLIENT_ID` is wrong or the OAuth client was deleted from Google console. |
| Endless redirect loop | `CLIENT_URL` likely misconfigured — server is redirecting to itself. Confirm it points to the React app, not the API. |
| "Access blocked: This app's request is invalid" | OAuth consent screen not yet published (still in "Testing" mode in Google console), and the user isn't on the test-user allowlist. |
| Google login works, but session doesn't persist | The callback issues tokens via URL params; `OAuthCallback.tsx` must parse them and store in localStorage. Check browser console. |

## See also

- [`/docs/security/auth-flows.md`](../security/auth-flows.md) — full auth flow including OAuth sequence diagram
- [`/docs/getting-started/local-dev.md`](../getting-started/local-dev.md) — setting up Google OAuth for local dev
- [`/docs/features/admin-panel.md#account-deletion-cross-cutting-feature`](../features/admin-panel.md) — how Google-signed-up users interact with account deletion
- [Passport Google OAuth 2.0 docs](https://www.passportjs.org/packages/passport-google-oauth20/)
