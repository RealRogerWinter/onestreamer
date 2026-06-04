# ADR-0025: Docker containers replace PM2 for the Node app

_Status: accepted_
_Date: 2026-06-04_

## Context

The Node app — the main server (`server/index.js`, HTTPS :8443) and the chat
microservice (`chat-service/index.js`, HTTPS :8444, ADR-0004) — ran on the VPS
under PM2 (`config/ecosystem.config.js`). We want reproducible, versioned,
rollback-able deploys driven by CI (ADR-0026), which PM2 + `git pull` did not
give us.

Containerizing a media app glued together over `127.0.0.1` is where this gets
sharp. The app dials, all on loopback: LiveKit signaling (ws/http :7882),
Redis :6379, Ollama :11434, Strapi :1337, the RTMP ingress push
(rtmp://127.0.0.1:1935), and the server↔chat self-calls (https://127.0.0.1:8443/8444).
LiveKit-server binds `127.0.0.1` **only** and is a frozen systemd host service;
LiveKit ingress/egress are host-networked containers. The app also terminates
its own TLS, writes a 2.4 GB SQLite DB, and shells out to ffmpeg / whisper.cpp /
python3 / streamlink / yt-dlp.

## Decision

Run the Node app as **two containers from one image** (`Dockerfile`), recreating
PM2's two processes. The chat container overrides the command (`compose.yaml`);
one image because chat lives in the repo tree, shares the `./certificates`
mount, and must share `JWT_SECRET`. The React client is **not** in the image —
it stays a static CRA bundle built in CI and rsynced to nginx's docroot.
LiveKit, ingress/egress, Redis, Ollama, Strapi and nginx are unchanged.

Hard choices, all verified against the running host:

- **`--network host`** (mandated, not preferred). LiveKit-server's loopback-only
  bind means a bridged container's `127.0.0.1` cannot reach it; host networking
  preserves every loopback dependency byte-for-byte and keeps the app out of the
  media datapath (LiveKit↔clients is UDP 50200-60000, not the app). Bridge
  networking is the long-term escape hatch only if LiveKit ever stops binding
  loopback.
- **Run as `--user 1001:1001` (claudeuser), never root.** The mounted
  `certificates/key.pem` is `0600 claudeuser` and `server/data/onestreamer.db`
  is `claudeuser`-owned; root or any other uid breaks TLS bind and DB writes.
  Net security win over PM2-as-root. One-time cutover: `chown -R 1001:1001
  /var/www/uploads/avatars` (nginx only reads it).
- **Default (private) PID namespace — never `--pid=host`.** The app runs
  `pkill -f ffmpeg` / `pkill chrome` (shutdown.js, IngressJanitor); a host PID
  namespace would reap the co-located livekit-egress and neighbouring containers.
  The deploy script refuses to start a container whose `PidMode=host`.
- **HTTPS-only listener.** The plain-HTTP listener now only binds when HTTPS is
  off (`server/bootstrap/start-listeners.js`, `chat-service/index.js`); under
  host networking it would otherwise collide with the livekit-ingress WHIP
  server already bound to `*:8080`. A new `BIND_ADDR` env seam binds the app to
  `127.0.0.1` so nginx is the sole public ingress regardless of firewall state.
- **Identical-path bind mounts.** Certs, the SQLite DB, uploads, recordings,
  clips, transcripts, audio-buffers, logs and the avatars dir are bind-mounted
  at the same absolute paths; `WORKDIR=/app` because `express.static('public')`
  and `('public/hls')` are cwd-relative. The chat moderation store is a
  **directory** mount (`/app/chat-state`) — never a single-file mount, which
  would break its atomic `${path}.tmp`→rename.
- **Image contents.** ffmpeg/ffprobe, streamlink, yt-dlp (pinned), python3 +
  curl_cffi (KickRandomService), procps, tini (PID 1, signal forwarding), and a
  built whisper.cpp `main` binary. The 600 MB whisper models are bind-mounted
  read-only, not baked. **No Chrome/Xvfb** — `EgressFrameCaptureService` uses
  ffmpeg; `launch-chrome-xvfb.sh` is orphaned.
- **Migrations stay auto-on-boot** (ADR-0022, forward-only, no down-migrations).

## Consequences

- Reproducible image per commit; rollback is `docker compose up` of the previous
  immutable digest (ADR-0026) — but only for **non-schema** releases. Schema
  changes have no down-migration, so rolling those back means restoring the
  pre-deploy DB snapshot (announced data loss). The deploy flags schema-changing
  releases.
- Host networking trades container isolation for correctness; the runbook
  forbids `ufw allow 8443/8444/8081` (loopback + nginx only) and the PID-ns
  guard prevents cross-container process reaping.
- Deploys are a brief hard cutover (stop-old → start-new): never two writers on
  the single-writer WAL DB. nginx 502s for the new container's cold start (idempotent
  migrations + LiveKit handshake before listeners bind) — tens of seconds.
- `ANNOUNCED_IP`, the public domain, and all secrets live in
  `/etc/onestreamer/app.env` (uncommitted), keeping the public repo scrubbed.

## Alternatives considered

- **Bridged compose + `host.docker.internal`** — rejected: LiveKit's
  loopback-only bind, the app's self-signed TLS to nginx upstreams, and ~half a
  dozen hardcoded `127.0.0.1` targets make it brittle for zero behavioural gain.
- **Containerize the whole media plane (LiveKit/ingress/egress)** — out of
  scope; they already run as host services/containers and need host networking
  anyway.
- **Run as root (like PM2)** — rejected: re-introduces the root blast radius we
  can cheaply drop, and uid 1001 already matches every mounted path's owner.
- **Bake the whisper models into the image** — rejected: 600 MB of static model
  data belongs on a read-only mount, not in every image layer.
