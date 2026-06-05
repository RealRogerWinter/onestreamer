# syntax=docker/dockerfile:1
###############################################################################
# OneStreamer application image — the Node server + chat-service (ADR-0025).
#
# Replaces the PM2 deployment. ONE image runs as TWO host-networked containers
# (compose.yaml overrides the command for the chat container). The React client
# is NOT in this image — it is built in CI and rsynced to nginx's docroot.
# LiveKit (systemd) + ingress/egress (containers), Redis, Ollama, Strapi and
# nginx all stay on the host and are reached over 127.0.0.1 (host networking).
#
# Base images are pinned to a minor tag here; pin by @sha256 digest before
# production (see the deploy runbook / security review).
###############################################################################

# ---- Stage 1: builder — native node modules + whisper.cpp ------------------
# Pinned by digest (tag node:18.20-bookworm) for reproducibility; bump via Dependabot.
FROM node:18.20-bookworm@sha256:c6ae79e38498325db67193d391e6ec1d224d96c693a8a4d943498556716d3783 AS builder

# Toolchain for native modules (better-sqlite3, sqlite3, sharp, bcrypt) + whisper.cpp.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install PRODUCTION deps only (--omit=dev) with build scripts ENABLED (native
# compiles) — NOT --ignore-scripts. Dev tooling (jest, nodemon, babel, supertest,
# concurrently) is never used inside the image; it only drags vuln surface into the
# runtime — that's how jest's minimatch/picomatch/semver were shipping and failing
# the trivy scan. Tests run in CI, in the node executor, NOT in this image.
# Copy only manifests first so the install layer caches on lockfile content.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY chat-service/package.json chat-service/package-lock.json ./chat-service/
RUN cd chat-service && npm ci --omit=dev --no-audit --no-fund

# Build whisper.cpp (pinned). The transcription / AI-moderation pipeline shells
# out to <repo>/whisper/whisper.cpp/main (server/services/transcription/WhisperRunner.js).
# The 600 MB models are NOT baked — they are bind-mounted read-only at runtime.
# Pinned to the exact commit v1.7.4 resolves to — git tags are mutable.
# Built STATIC (-DBUILD_SHARED_LIBS=OFF): newer whisper.cpp defaults to shared libs,
# so the copied `main` would dynamically link libwhisper.so.1 / libggml*.so — which
# aren't in the runtime image (-> "libwhisper.so.1: cannot open shared object file",
# exit 127, transcription/AI-bots dead). Static = self-contained binary (only libgomp1).
# AVX-512 disabled: CI builders have AVX-512 but the production VPS is AVX2-only; the
# mismatch produces SIGILL at runtime (whisper loads, starts processing, then crashes).
# Disabling -DGGML_AVX512* keeps the binary AVX2-compatible on any x86-64 with AVX2.
ARG WHISPER_CPP_SHA=8a9ad7844d6e2a10cddf4b92de4089d7ac2b14a9
RUN git -c advice.detachedHead=false clone https://github.com/ggerganov/whisper.cpp /tmp/wcpp \
    && git -C /tmp/wcpp checkout -q "${WHISPER_CPP_SHA}" \
    && test "$(git -C /tmp/wcpp rev-parse HEAD)" = "${WHISPER_CPP_SHA}" \
    && cmake -S /tmp/wcpp -B /tmp/wcpp/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF -DGGML_AVX512=OFF -DGGML_AVX512_VBMI=OFF -DGGML_AVX512_VNNI=OFF \
    && cmake --build /tmp/wcpp/build -j --target whisper-cli \
    && mkdir -p /app/whisper/whisper.cpp \
    && cp /tmp/wcpp/build/bin/whisper-cli /app/whisper/whisper.cpp/main \
    && rm -rf /tmp/wcpp

# ---- Stage 2: runtime ------------------------------------------------------
# Pinned by digest (tag node:18.20-bookworm-slim); same Node 18 / bookworm ABI as the builder.
FROM node:18.20-bookworm-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e AS runtime

# Runtime OS deps the app shells out to:
#   ffmpeg/ffprobe          viewbot / url-relay / recording / egress frame capture
#   streamlink + yt-dlp     URL-stream extraction (yt-dlp also used by the SSRF guard)
#   python3 + curl_cffi     KickRandomService -> server/services/kick-api-helper.py
#   procps                  pkill/kill in shutdown.js + IngressJanitor
#   tini                    PID 1 — forwards SIGTERM to Node's graceful drain
#   curl                    HEALTHCHECK
#   libgomp1                whisper.cpp OpenMP runtime
# Bump when site extractors (e.g. Twitch) break — stale yt-dlp fails URL relay
# with "KeyError('data')". Verify the binary against a live Twitch URL after bumping.
ARG YT_DLP_VERSION=2026.03.17
# `apt-get upgrade` pulls debian security patches on top of the pinned base digest
# (clears the trivy OS findings, e.g. libgnutls30 CVE-2026-33845). curl_cffi bumped
# to 0.15.0 for CVE-2026-33752 (redirect SSRF) — verify KickRandomService still
# works (server/services/kick-api-helper.py) after this jump from 0.7.x.
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        ffmpeg streamlink python3 python3-pip procps tini curl ca-certificates libgomp1 \
    && pip3 install --no-cache-dir --break-system-packages "curl_cffi==0.15.0" \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/SHA2-256SUMS" -o /tmp/yt-dlp.sums \
    && awk '$2=="yt-dlp"{print $1"  /usr/local/bin/yt-dlp"}' /tmp/yt-dlp.sums | sha256sum -c - \
    && chmod 0755 /usr/local/bin/yt-dlp && rm -f /tmp/yt-dlp.sums \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# The runtime entrypoint is `node ...` — no package manager is ever invoked here,
# but the base image's GLOBAL node_modules (npm AND corepack) vendor their own deps
# (tar, minimatch 3.1.2, semver 7.0.0, …) which trivy flags as node-pkg findings.
# Nuke the whole global dir + the pm shims: fewer CVEs, smaller attack surface.
# (The builder stage keeps its own npm for `npm ci`; only the runtime is stripped.)
RUN rm -rf /usr/local/lib/node_modules \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

# App code + built deps. WORKDIR=/app is load-bearing: server/index.js serves
# express.static('public') and ('public/hls') relative to cwd. Client is NOT shipped.
COPY --chown=1001:1001 server/ ./server/
COPY --chown=1001:1001 chat-service/ ./chat-service/
COPY --chown=1001:1001 config/ ./config/
COPY --chown=1001:1001 scripts/ ./scripts/
COPY --chown=1001:1001 public/ ./public/
COPY --chown=1001:1001 package.json package-lock.json ./
COPY --from=builder --chown=1001:1001 /app/node_modules ./node_modules
COPY --from=builder --chown=1001:1001 /app/chat-service/node_modules ./chat-service/node_modules
COPY --from=builder --chown=1001:1001 /app/whisper ./whisper

# The app creates cwd-relative scratch dirs under /app at boot (public/hls via
# SimpleMediaStreamService; temp/audio + temp/transcription via AudioBufferService
# / TranscriptionService). Pre-create + chown ONLY those — leave /app itself
# root-owned so a compromised runtime uid can't create/replace top-level code or
# deps (PR #3 security review). Every other write target is a uid-1001 bind mount.
RUN mkdir -p /app/public/hls /app/temp/audio /app/temp/transcription \
    && chown -R 1001:1001 /app/public /app/temp

# Run as uid 1001 (matches the VPS on-disk owner of the bind-mounted certs / DB /
# recordings) — never root (ADR-0025). The container keeps the DEFAULT (private)
# PID namespace; never run it with --pid=host (the app runs pkill ffmpeg/chrome).
USER 1001:1001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]

# Liveness only. Deploy verification additionally checks dependency-touching
# signals (LiveKit/Redis init in the logs) — /health is static. (compose.yaml
# overrides the port for the chat container.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsk https://127.0.0.1:8443/health || exit 1
