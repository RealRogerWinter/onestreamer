# Branching and releases

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer is a small project with rolling deployments. The branch / release model is intentionally lightweight — formal release engineering would be overkill at this scale, but a few minimal habits keep the history readable.

## Branches

- **`main`** — the production branch. Deployed via manual `git pull` on the prod host (see [`/docs/operations/deployment.md`](../operations/deployment.md)).
- **Feature branches** — branch from `main`, name with a short kebab-case description: `add-clip-thumbnails`, `fix-livekit-reconnect`, `docs/overhaul`.
- **No long-lived release branches.** No `develop`, no `staging`, no `next`.

When you start a piece of work:

```bash
git checkout main
git pull
git checkout -b <kebab-name>
```

When you finish:

1. Push the branch.
2. Open a PR against `main`.
3. Self-review (and request from collaborators if any).
4. Merge — squash is the default, preserving a clean linear history on `main`. Merge commits are fine for substantial multi-commit branches if the individual commits are coherent.
5. Delete the branch.

## Commits

- **Imperative mood** in the subject line: "Add clip thumbnails", not "Added clip thumbnails" or "Adds clip thumbnails".
- **Keep subjects under ~72 characters.**
- **Body optional** but encouraged for non-trivial changes — explain the *why*, not just the *what*. The code diff shows the what.
- **Reference issues** when applicable: `Closes #123`, `Refs #456`.

Examples:

```text
Fix takeover cooldown leak when admin disconnects
Move TURN credential signing to server-side
Document the Sept-2025 LiveKit rollback as ADR-0003
```

Not:

```text
fix
update stuff
WIP
```

## Pull requests

Use the PR template (added in [`/.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md)) — it includes:

- **Summary** (what + why)
- **Testing notes** (how you verified)
- **Docs update checkbox** — the single most important hygiene check
- **Linked issues** if any

For docs-only PRs, the testing checkbox can be "rendered docs in GitHub UI" or similar — but the doc-update checkbox is gone (it's a self-referential PR).

## Releases

> [!NOTE]
> OneStreamer historically had no tagged releases (only 2 commits at the time of the docs overhaul). This section describes the convention going forward; existing history won't be retroactively tagged.

### Semver, loosely

Use [Semantic Versioning](https://semver.org/) with the standard `MAJOR.MINOR.PATCH` interpretation:

- **MAJOR**: breaking changes (DB schema requires manual migration; env vars renamed; admin API surface change)
- **MINOR**: new features, backward-compatible
- **PATCH**: bug fixes, no API or behavior changes visible to users

Pre-1.0 (we are pre-1.0): MINOR bumps can include breaking changes per semver convention. Document them clearly.

### CHANGELOG

[`/CHANGELOG.md`](../../CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
## [Unreleased]
### Added
- New feature
### Changed
- Modified behavior
### Deprecated
- Soon-to-be-removed
### Removed
- Now-gone features
### Fixed
- Bug fixes
### Security
- Security patches

## [0.2.0] - 2026-06-XX
### Added
- ...
```

Every meaningful PR adds an entry under `## [Unreleased]`. When you tag a release, rename `[Unreleased]` to the new version + date and start a fresh `[Unreleased]` section.

### Tagging

```bash
# After updating CHANGELOG.md and merging to main
git checkout main
git pull
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

Use `gh release create v0.2.0 --generate-notes` for a GitHub release page if you want one (cheap; nice for visibility).

### Deploy cadence

No fixed cadence today. Deploy when ready — could be daily, could be weekly. The "tag a release" step is just a documentation artifact; nothing automated triggers off it.

For the prod deploy workflow itself, see [`/docs/operations/deployment.md`](../operations/deployment.md) and [`/docs/operations/upgrades.md`](../operations/upgrades.md).

## Branch protection (recommended)

Once the project has more than one regular contributor, enable on GitHub:

- **Require pull request before merging** to `main`
- **Require status checks to pass** (the CircleCI checks from [`/.circleci/config.yml`](../../.circleci/config.yml), [ADR-0026](../architecture/adr/0026-circleci-pipeline.md))
- **Dismiss stale approvals** when new commits are pushed

Until then, self-merge is fine — but still go through a PR for the changelog/audit benefit.

## Hotfix flow

When production is broken:

1. Branch from `main`: `git checkout -b hotfix/<description>`.
2. Make the minimal change.
3. PR + merge with whatever urgency the situation requires.
4. Deploy.
5. Tag a PATCH release (`v0.2.1`) once the dust settles — even for hotfixes. The tag makes "what was deployed when" answerable in a year.

## See also

- [`coding-conventions.md`](coding-conventions.md) — style and file layout
- [`testing.md`](testing.md) — what runs in CI
- [`/docs/operations/upgrades.md`](../operations/upgrades.md) — production deploy procedure
- [`/CHANGELOG.md`](../../CHANGELOG.md) — actual release history
- [`/CONTRIBUTING.md`](../../CONTRIBUTING.md) — top-level contributor guide
