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
FROM node:18.20-bookworm AS builder

# Toolchain for native modules (better-sqlite3, sqlite3, sharp, bcrypt) + whisper.cpp.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps with build scripts ENABLED (native compiles) — NOT --ignore-scripts.
# Copy only manifests first so the install layer caches on lockfile content.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY chat-service/package.json chat-service/package-lock.json ./chat-service/
RUN cd chat-service && npm ci --no-audit --no-fund

# Build whisper.cpp (pinned). The transcription / AI-moderation pipeline shells
# out to <repo>/whisper/whisper.cpp/main (server/services/transcription/WhisperRunner.js).
# The 600 MB models are NOT baked — they are bind-mounted read-only at runtime.
ARG WHISPER_CPP_REF=v1.7.4
RUN git clone --depth 1 --branch "${WHISPER_CPP_REF}" https://github.com/ggerganov/whisper.cpp /tmp/wcpp \
    && cmake -S /tmp/wcpp -B /tmp/wcpp/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /tmp/wcpp/build -j --target whisper-cli \
    && mkdir -p /app/whisper/whisper.cpp \
    && cp /tmp/wcpp/build/bin/whisper-cli /app/whisper/whisper.cpp/main \
    && rm -rf /tmp/wcpp

# ---- Stage 2: runtime ------------------------------------------------------
FROM node:18.20-bookworm-slim AS runtime

# Runtime OS deps the app shells out to:
#   ffmpeg/ffprobe          viewbot / url-relay / recording / egress frame capture
#   streamlink + yt-dlp     URL-stream extraction (yt-dlp also used by the SSRF guard)
#   python3 + curl_cffi     KickRandomService -> server/services/kick-api-helper.py
#   procps                  pkill/kill in shutdown.js + IngressJanitor
#   tini                    PID 1 — forwards SIGTERM to Node's graceful drain
#   curl                    HEALTHCHECK
#   libgomp1                whisper.cpp OpenMP runtime
ARG YT_DLP_VERSION=2025.05.22
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg streamlink python3 python3-pip procps tini curl ca-certificates libgomp1 \
    && pip3 install --no-cache-dir --break-system-packages "curl_cffi==0.7.4" \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

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

# public/hls is written at runtime (SimpleMediaStreamService.mkdirSync) — make
# /app/public writable by the runtime uid.
RUN mkdir -p /app/public/hls && chown -R 1001:1001 /app/public

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
