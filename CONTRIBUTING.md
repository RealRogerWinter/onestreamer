# Contributing to OneStreamer

Pull requests welcome. This file is the short version; the long-form contributor guide lives in [`/docs/contributing/`](docs/contributing/).

## Before you start

1. **Read the existing code.** OneStreamer has accumulated patterns (the `<Thing>Service` shape, `global.serviceName` singletons, emoji-prefixed logs) — match what's there rather than reinventing.
2. **Check the relevant feature doc.** Most areas have a `/docs/features/<feature>.md` page that explains *what* and *why* before you read the *how*.
3. **For non-trivial design choices, plan to write an ADR.** See [`/docs/architecture/adr/README.md`](docs/architecture/adr/README.md).

## Setup

```bash
git clone https://github.com/onestreamer/onestreamer.git
cd onestreamer
npm run install-all
cp .env.example .env             # then edit; see docs/getting-started/environment-variables.md
cp server/.env.example server/.env
npm run dev                      # main + chat + client
# open https://localhost:3443
```

Full setup walkthrough: [`/docs/getting-started/local-dev.md`](docs/getting-started/local-dev.md).
End-to-end smoke test: [`/docs/getting-started/first-stream.md`](docs/getting-started/first-stream.md).

## Branch + commit conventions

- Branch from `main` with a kebab-case name: `add-clip-thumbnails`, `fix-livekit-reconnect`.
- Commits in imperative mood under ~72 characters: "Fix takeover cooldown leak", not "Fixed".
- Body optional; explain the *why* for non-trivial changes.
- One PR per logical change. Squash on merge is the default.

Full conventions: [`/docs/contributing/branching-and-releases.md`](docs/contributing/branching-and-releases.md).

## Pull request checklist

Every PR is expected to address the following (the PR template will prompt):

- [ ] **Code follows existing conventions** (see [`/docs/contributing/coding-conventions.md`](docs/contributing/coding-conventions.md))
- [ ] **Tests added or updated** if touching auth, points/items, admin actions, or migrations (see [`/docs/contributing/testing.md`](docs/contributing/testing.md))
- [ ] **Docs updated**: README / `/docs/features/` / `/docs/architecture/` / new ADR / new runbook / N/A
- [ ] **CHANGELOG entry** added under `## [Unreleased]`
- [ ] **CI passes** (typecheck + lint + tests)
- [ ] **No new secrets in committed code** — env vars only

## The five categories of new documentation

When you're about to add a new `.md` file, ask: which of these is it?

| Type | Where | Template |
|------|-------|----------|
| **Feature explanation** | `/docs/features/<name>.md` | see existing files for shape |
| **Architecture decision** | `/docs/architecture/adr/NNNN-kebab-title.md` | [ADR template](docs/architecture/adr/README.md) |
| **External integration** | `/docs/integrations/<provider>.md` | see existing files for shape |
| **Operations / runbook** | `/docs/operations/...` or `/docs/operations/runbooks/<incident>.md` | [Runbook template](docs/operations/runbooks/README.md) |
| **API reference** | `/docs/api/rest.md` or `/docs/api/socket-events.md` | add a table row |

**If it doesn't fit any of these categories, don't add it.** The repo had 61 stray `.md` files at root before the docs overhaul — this rule prevents the recurrence.

## Repo-root markdown rule

Only six markdown files are allowed at the repo root:

- `README.md`
- `CONTRIBUTING.md` (this file)
- `SECURITY.md`
- `CHANGELOG.md`
- `LICENSE`
- `CLAUDE.md` (if present — agent context)

Anything else lives in `/docs/`. A PR that adds a new `.md` to the root should be rejected on review.

## Reviewing PRs

If you have review rights, the goal is to ship — not to make the PR perfect:

- **Block on**: security issues, data-loss risks, missing tests for critical paths, missing docs for new features
- **Note as follow-up**: style nits, naming preferences, opportunistic refactors, additional test coverage
- **Don't block on**: subjective code style if it matches existing patterns

## Code of conduct

Be decent. There's no formal code-of-conduct document because the contributor pool is small and the standards are obvious; if that changes, this section grows.

## Security reports

See [`SECURITY.md`](SECURITY.md). Don't open public issues for vulnerabilities.

## Questions

Open a GitHub Discussion or an issue. Tag the maintainers.

## See also

- [`/docs/`](docs/) — the full documentation tree
- [`/docs/contributing/`](docs/contributing/) — long-form contributor docs
- [`README.md`](README.md) — project overview
