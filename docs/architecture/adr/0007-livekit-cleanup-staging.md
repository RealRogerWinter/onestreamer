# ADR-0007: Staged removal of dormant LiveKit infrastructure

_Status: accepted_
_Date: 2026-05-23_

## Context

LiveKit has been dormant infrastructure since the Sept 2025 dual-stack rollback ([ADR-0002](0002-mediasoup-primary-livekit-dormant.md), [ADR-0003](0003-livekit-dual-stack-rollback.md)). PR-E (#25) already removed 13 orphan LiveKit files. What remains in the live tree:

| Category | Files |
|----------|-------|
| Per-deploy config (repo root) | `livekit-config.yaml`, `livekit-ssl.yaml` |
| Server services | `server/services/LiveKitService.js`, `server/services/ViewBotLiveKitService.js` |
| Client SDK wrapper | `client/src/services/LiveKitClient.ts` (~57 KB) |
| npm dependencies | `@livekit/rtc-node`, `livekit-client`, `livekit-server-sdk` (~50 MB in `node_modules`) |

The security review on PR-C ("untrack TLS and nginx") flagged the two root-level `livekit-*.yaml` files: they contain per-deploy values (public IP `<SERVER_IP>`, the literal `devkey` / `secret` credentials, cert paths) and have the same shape as the nginx server-blocks PR-C handled. They should never have been tracked in git.

Removing **all** of the above in a single PR is tempting but risky: the JS/TS services and the npm deps are referenced from conditional code paths in `server/index.js` (the `WEBRTC_BACKEND` branch and the viewbot pipeline). Tracing those paths to confirm they are truly unreachable requires deeper analysis than a config-untracking PR should bundle. A single big-bang LiveKit-removal PR would also be hard to bisect if it destabilizes anything downstream.

## Decision

**Stage the LiveKit cleanup across multiple PRs**, starting with the lowest-risk piece (config untracking) and deferring code/dependency removal until the dormant code paths have been traced.

**This PR (PR-S, `cleanup/dormant-livekit`):**
1. `git rm` the tracked `livekit-config.yaml` and `livekit-ssl.yaml`.
2. Add sanitized `livekit-config.example.yaml` and `livekit-ssl.example.yaml` references at the repo root (same convention as PR-C's `nginx/onestreamer.example.conf`).
3. Add both yaml paths to `.gitignore`.
4. Update `docs/integrations/livekit.md` to point at the new `.example.yaml` reference and at this ADR.
5. **Do not touch** `*.js` or `*.ts` files, npm dependencies, or PM2 / systemd unit configuration.

**Deferred to a follow-up PR (informally "PR-S2"):**
- Trace the conditional code paths in `server/index.js` that reference `LiveKitService` and `ViewBotLiveKitService`.
- Confirm by static read + smoke-test that no production path can reach them under any `WEBRTC_BACKEND` value.
- Delete `LiveKitService.js`, `ViewBotLiveKitService.js`, and `LiveKitClient.ts`.
- Drop `@livekit/rtc-node`, `livekit-client`, `livekit-server-sdk` from `package.json` and `client/package.json`.

If PR-S2 surfaces a live reference (e.g., a viewbot variant we did not know about), the deferral was justified.

## Consequences

**Positive.**
- The `<SERVER_IP>` IP and the `devkey` / `secret` credentials are no longer in tracked history going forward. (History rewrite is out of scope; the secrets are well-known LiveKit defaults that should be rotated regardless — see [`/docs/operations/runbooks/secret-rotation.md`](../../operations/runbooks/secret-rotation.md).)
- Future deploys must consciously copy the `.example.yaml` and substitute their own values, matching the established pattern from PR-C.
- The PR is small, focused, and trivially reviewable — config files only, no JS, no risk to the runtime.
- The shape of a LiveKit deployment is preserved (in the `.example.yaml` files), so a future revival per ADR-0003 has a starting point instead of having to rediscover the config from scratch.

**Negative.**
- LiveKit is not fully removed in one stroke. The ~50 MB of `node_modules` weight remains; the ~57 KB of `LiveKitClient.ts` stays; the dormant services remain in the dependency graph.
- A reviewer reading the codebase still sees LiveKit references and may infer (incorrectly) that it is live. The dormancy is documented in ADR-0002 and the `livekit.md` integration page, but the live-tree presence creates ambiguity until PR-S2 lands.
- Two PRs instead of one means slightly more review surface area in aggregate.

## Alternatives considered

- **Remove everything in one PR.** Rejected as too broad. The config-untracking is a security cleanup (the credentials should never have been in git); the code/dep removal is a refactor that depends on tracing conditional paths. Bundling them obscures both.
- **Defer all LiveKit cleanup until ADR-0002 is reversed or made permanent.** Rejected because the security reviewer on PR-C explicitly flagged the root yaml files. Leaving committed `devkey` / `secret` credentials waiting for a future decision is unacceptable hygiene.
- **Just `git rm` the yaml files without `.example.yaml` siblings.** Rejected because the config shape is non-obvious (NAT 1-to-1 mapping, Cloudflare TURN-over-IP quirk, H264 codec ordering for iOS Safari). A future revival would have to rediscover these details from archived docs.
- **Untrack via `git update-index --skip-worktree`.** Rejected — that only affects the local working copy and does not prevent the files from being recommitted by a different contributor. `.gitignore` + `git rm` is the durable answer.

## References

- [ADR-0002: MediaSoup primary, LiveKit dormant](0002-mediasoup-primary-livekit-dormant.md)
- [ADR-0003: LiveKit dual-stack rollback (Sept 2025)](0003-livekit-dual-stack-rollback.md)
- [`/docs/integrations/livekit.md`](../../integrations/livekit.md)
- [`/docs/operations/runbooks/secret-rotation.md`](../../operations/runbooks/secret-rotation.md)
- PR-C (`security/untrack-tls-and-nginx`) — established the `.example.conf` + `.gitignore` pattern this PR follows
- PR-E (#25) — removed the orphan LiveKit files
