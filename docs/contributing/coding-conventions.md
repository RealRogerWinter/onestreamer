# Coding conventions

_Last verified: 2026-05-23 against commit 4a1d325._

Pragmatic conventions that match how OneStreamer is actually written today. The goal is consistency, not perfection. Prefer the patterns already in use over inventing new ones.

## File layout

```
/                       # root
├── server/             # main Node server (Express + Socket.IO)
│   ├── index.js        # entry point, ~10k lines (could be split, but is what it is)
│   ├── config/         # config modules
│   ├── database/       # schema files + database.js
│   ├── middleware/     # auth, turnstile
│   ├── migrations/     # ad-hoc migration scripts
│   ├── routes/         # Express route handlers, one file per feature area
│   └── services/       # the workhorse modules — one class per file, ~100 total
├── chat-service/       # chat microservice
│   └── index.js        # ~4,700 lines; intentionally not split
├── client/             # React app (CRA)
│   ├── src/
│   │   ├── components/ # one component per file; ~109 total
│   │   ├── contexts/   # React contexts (SocketContext, etc.)
│   │   ├── hooks/      # custom hooks
│   │   ├── services/   # client-side services (AuthService, SocketManager, etc.)
│   │   ├── types/      # shared TS types
│   │   └── utils/      # pure utilities
│   └── public/         # static assets
└── docs/               # this documentation tree
```

### Where things go

- **A new HTTP endpoint** → add to the relevant `server/routes/*.js`, or create a new file if it doesn't fit an existing category. Register it in `server/index.js`.
- **A new backend service** → `server/services/NewService.js`. See [`adding-a-service.md`](adding-a-service.md).
- **A new React component** → `client/src/components/<Name>.tsx` plus its `.css` if it has styles.
- **A new socket event** → add the listener / emit site in the relevant service, and document it in [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) and [`/docs/api/socket-events.md`](../api/socket-events.md).
- **A new database table or column** → write a migration script in `server/migrations/`, document the schema in [`/docs/architecture/data-model.md`](../architecture/data-model.md), update [`server/database/database.js`](../../server/database/database.js) if it should be created on first boot.
- **A new ADR** → `docs/architecture/adr/NNNN-kebab-title.md`. See [`/docs/architecture/adr/README.md`](../architecture/adr/README.md).
- **A new runbook** → `docs/operations/runbooks/<incident-class>.md`. See [`/docs/operations/runbooks/README.md`](../operations/runbooks/README.md).

## Naming

- **JS files**: PascalCase for classes (`StreamService.js`), camelCase for non-class modules (`webrtc.config.js`)
- **TypeScript components**: PascalCase (`StreamerSettings.tsx`)
- **CSS files**: PascalCase matching component (`StreamerSettings.css`)
- **Database tables**: `snake_case`
- **Database columns**: `snake_case`
- **Socket events**: `kebab-case` (`stream-ready`) or `colon:separated` for grouped events (`game:full-state`, `admin:start-game`)
- **REST endpoints**: `kebab-case` paths (`/api/random-stream/start`)
- **Env vars**: `SCREAMING_SNAKE_CASE`
- **Client-only env vars**: prefix with `REACT_APP_` (CRA requirement)

## Indentation + formatting

- **2 spaces** for indentation (JS, TS, JSX, JSON, YAML)
- **No tabs**
- **LF line endings** (Unix-style)
- **Trailing newline at EOF**
- **Single quotes** for strings (unless they contain a single quote — then double quotes or template literal)
- **Trailing commas** in multi-line arrays/objects (helps diffs)
- **Semicolons** at end of statements (the codebase uses them; don't fight it)
- **Arrow functions over `function`** in callbacks
- **`const` over `let` over `var`** — `var` should never appear in new code

No `prettier` or `eslint --fix` is set up today, so manual discipline. Adding one would be a follow-up.

## Comments

**Default to writing no comments.**

Add a comment only when the *why* is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.

**Never:**

- Don't explain *what* code does — well-named identifiers do that.
- Don't reference the current task, fix, or callers ("used by X", "added for the Y flow"). Those belong in the PR description and rot fast.
- Don't write multi-paragraph docstrings or block comments — one short line max.

**Example good comment:**

```js
// DTX must stay off — re-enabling causes audio dropouts mid-stream
// (see ADR-XXXX if we ever revisit)
const opusConfig = { dtx: false, ... };
```

**Example bad comment:**

```js
// Get the user from the database
const user = await db.getUserById(id);
```

## Logging

Use emoji-prefixed log lines for important events. The convention has emerged organically:

| Prefix | Category |
|--------|----------|
| `🔨 MODERATION:` | Mod actions |
| `🚫 MODERATION:` / `🚫 CONNECTION:` / `🚫 STREAMING:` | Bans / blocks |
| `✅ MODERATION:` | Unbans / approvals |
| `📡 LIVEKIT:` | WebRTC events (LiveKit is the sole backend) |
| `🎬 RECORDING:` | Recording pipeline |
| `🗑️ DELETION SCHEDULER:` | Account-deletion runs |
| `📧` | Email send (verification, reset, etc.) |
| `🎵 SOUNDFX:` | Sound effects |
| `🎬 VISUALFX:` | Visual effects |
| `🤖` | Chatbot activity |
| `⚠️` / `❌` | Warnings / errors |

This makes `grep | pm2 logs` workflows fast. Continue the pattern in new code.

For structured logging, use `console.log` / `console.error`. No third-party logger today (could be a future improvement).

## Error handling

- **Don't swallow errors silently** — at minimum, `console.error` them.
- **Don't catch what you can't handle** — let the error propagate to a higher layer that can.
- **HTTP routes should return appropriate status codes** (`400` for client error, `401` for auth missing, `403` for auth wrong, `404` not found, `500` for server error, etc.) — see existing routes for the pattern.
- **Socket handlers should emit an error event** to the offending client when the action can't be completed, instead of silently failing.

## Async patterns

- **Use `async`/`await`** over `.then()` chains. The codebase is mostly already this style.
- **Avoid mixing styles in one function.**
- **Always handle promise rejections** at the top of every async path (route handler, socket handler, scheduler tick).
- **For cleanup, prefer `try`/`finally`** rather than scattered cleanup calls.

## React conventions

- **Functional components only** in new code — no class components.
- **Hooks for state and effects.**
- **`useCallback` and `useMemo` only when measurably needed** — premature memoization is a tax on readers.
- **Component files house one default export** (the component) plus any local types/helpers used only by it.
- **CSS via per-component `.css` files** matching the component name. No CSS-in-JS or Tailwind in current use.
- **TypeScript types** in `client/src/types/` if shared across files; otherwise inline.

## TypeScript

- **`tsconfig.json`** is CRA-default. No `strict: true` today (some files lean on `any` more than is ideal).
- **Prefer explicit types** at function boundaries (params, return types).
- **`unknown` over `any`** when you don't know the type.
- **Type imports** with `import type { ... }` syntax for type-only imports.

## What's intentionally not enforced

- **Comprehensive tests.** Tests exist but coverage is patchy. Don't gate every PR on adding tests; do gate critical-path additions. See [`testing.md`](testing.md).
- **API versioning.** REST endpoints aren't versioned. Breaking changes go in coordinated waves.
- **Backward compat shims.** Remove deprecated code rather than maintaining adapters indefinitely.
- **100% prettier-clean formatting.** Manual discipline today.

## Repo-root markdown hygiene rule

**Only six markdown files are allowed at the repository root:**

`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `CLAUDE.md`.

Everything else lives in `/docs/`. This rule exists because the project once had 61 `FIX_FINAL_*.md` files at the repo root — exactly the failure mode that triggered this docs overhaul. The rule prevents recurrence.

If you have new documentation to add:

- **Feature explanation** → `/docs/features/`
- **Architecture decision** → `/docs/architecture/adr/` (it's an ADR)
- **How-to / setup** → `/docs/getting-started/` or `/docs/operations/`
- **Integration** → `/docs/integrations/`
- **Runbook** → `/docs/operations/runbooks/`
- **Historical fix note** → don't write one; write an ADR or runbook instead

## See also

- [`branching-and-releases.md`](branching-and-releases.md) — branch naming, commits, releases
- [`testing.md`](testing.md) — test layout and CI
- [`adding-a-service.md`](adding-a-service.md) — shape of a new backend service
- [`/docs/architecture/adr/README.md`](../architecture/adr/README.md) — when to write an ADR
- [`/docs/operations/runbooks/README.md`](../operations/runbooks/README.md) — when to write a runbook
