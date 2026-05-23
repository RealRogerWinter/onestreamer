# OneStreamer Documentation

Welcome to the OneStreamer docs. OneStreamer is a self-hosted live-streaming platform deployed at [onestreamer.live](https://onestreamer.live). This tree is organized by **audience**, not by code module — find what you need by the role you are playing right now.

## Where to go

| You are… | Start here |
|----------|------------|
| **A first-time visitor** — what is this project? | Top-level [`/README.md`](../README.md), then [`architecture/overview.md`](architecture/overview.md). |
| **An operator** — running OneStreamer in production | [`operations/`](operations/) for deployment, backups, monitoring, upgrades. Incident runbooks live in [`operations/runbooks/`](operations/runbooks/). |
| **A developer** — setting up locally for the first time | [`getting-started/local-dev.md`](getting-started/local-dev.md), then [`getting-started/first-stream.md`](getting-started/first-stream.md). |
| **A feature reader** — how does X work? | [`features/`](features/) — one file per user-facing feature. |
| **An architecture reader** — why is the system shaped this way? | [`architecture/`](architecture/). Past design decisions are recorded as ADRs in [`architecture/adr/`](architecture/adr/). |
| **A wire-protocol reader** — what endpoints and events exist? | [`api/rest.md`](api/rest.md) and [`api/socket-events.md`](api/socket-events.md). |
| **An integrator** — wiring up LiveKit / B2 / Google OAuth / etc. | [`integrations/`](integrations/). |
| **A contributor** — coding conventions, branching, testing | [`contributing/`](contributing/). |
| **A security reviewer** — threat model, auth flows | [`security/`](security/). |
| **A historian** — what got tried and rolled back? | [`archive/`](archive/) — preserved fix logs and dead plans, **not maintained**. See [`archive/README.md`](archive/README.md). |

## Tree

```
docs/
├── README.md                          this file — the index
├── getting-started/                   first-run for any audience
├── operations/                        runbook / operator content
│   └── runbooks/                      one file per incident class
├── features/                          how each user-facing feature works
├── architecture/                      design decisions and topology
│   └── adr/                           Architecture Decision Records — append-only
├── integrations/                      one file per external dependency
├── api/                               REST + socket reference
├── contributing/                      internal contributor docs
├── security/                          threat model, auth flows
└── archive/                           historical fix notes; not maintained
```

## Conventions

- **Freshness header.** Every doc starts with `_Last verified: YYYY-MM-DD against commit <sha>._` — bump the date when you re-read and confirm the doc. If you find it wrong, fix it or add a `> [!WARNING] Stale — pending rewrite` banner.
- **Status banners.** Features that are partially-implemented, broken, or deprecated get a banner at the top of their doc.
- **Repo-root markdown hygiene.** Only six `.md` files are allowed at the repo root: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, `CLAUDE.md`. Everything else lives in `docs/`. See [`/CONTRIBUTING.md`](../CONTRIBUTING.md) for the rule.

## ADRs and runbooks

When you make a non-trivial design decision, **write an ADR** in [`architecture/adr/`](architecture/adr/) — the template is in that folder's README.
When you debug a gnarly prod incident, **write a runbook** in [`operations/runbooks/`](operations/runbooks/) — the template is in that folder's README.

These two habits are the single most important thing for keeping these docs alive. Without them, knowledge ends up as `FIX_FINAL_*.md` files at the repo root — exactly the failure mode this overhaul was undoing.
