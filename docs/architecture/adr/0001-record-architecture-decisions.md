# ADR-0001: Record architecture decisions

_Status: accepted_
_Date: 2026-05-23_

## Context

OneStreamer has accumulated significant architectural complexity (LiveKit dual-stack attempted and rolled back, multiple transcription implementations, ~20 viewbot variants, etc.). The "why" behind these decisions lives in scattered commit messages, deleted Slack threads, and the heads of people who may not be around in six months.

Future contributors (including future-us) will second-guess these decisions if they're not documented. Re-litigating already-resolved debates is expensive. Worse: silently undoing a deliberate decision because nobody knew the reasoning.

## Decision

This project records non-trivial architectural decisions as **Architecture Decision Records** (ADRs) in [`/docs/architecture/adr/`](.). Format: a lightweight Michael Nygard template (Context / Decision / Consequences / Alternatives), one numbered file per decision, append-only.

ADRs are written when:
- A non-trivial design decision is made (which-library, which-approach, accept-which-tradeoff)
- A decision will be second-guessed if not written down
- A decision reverses or supersedes a prior ADR (in which case, write a new ADR that supersedes the old — **never edit the old one**)

ADRs are *not* written for:
- Implementation details ("we used Map not Object")
- Bug fixes (those become runbook entries)
- Style / convention choices (those go in [`/docs/contributing/coding-conventions.md`](../../contributing/coding-conventions.md))

## Consequences

**Positive.**
- New contributors can read the ADR register and understand the system's logic in an hour rather than a week.
- Reverse-engineering "why is X this way?" from code or commit history becomes unnecessary.
- A natural artifact emerges from design discussions, with a known home.

**Negative.**
- Writing ADRs adds friction to design decisions. The hope is that the friction discourages only *trivial* decisions and not real architectural choices.
- ADRs are append-only — bad early decisions cast a shadow forever. Mitigated by clear `Status: superseded by ADR-XXXX` headers.
- Discipline required: contributors need to actually write ADRs, not just have meetings and move on. Mitigated by the doc-update checkbox in the PR template.

## Alternatives considered

- **Confluence / Notion docs.** Lose locality with the code, often get forgotten, hard to grep, not version-controlled with the change they describe.
- **Just-the-commit-message.** Doesn't survive `git log` skimming; doesn't survive squash merges; doesn't surface unless you know to look.
- **A formal RFC process.** Too heavyweight for a single-team project. ADRs are intentionally lighter than RFCs.
- **Wiki.** GitHub wikis aren't reviewable in PRs, aren't checked into the repo, and were a major contributor to the 61-fix-log-files-at-root mess this overhaul cleaned up.

## References

- [Michael Nygard's original ADR post (2011)](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [adr.github.io](https://adr.github.io/)
- [joelparkerhenderson/architecture-decision-record](https://github.com/joelparkerhenderson/architecture-decision-record) — template collection
