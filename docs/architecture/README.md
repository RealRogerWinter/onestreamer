# Architecture

The "why" behind the system shape. ADRs in [`adr/`](adr/) capture historical decisions.

| File | Covers |
|------|--------|
| [`overview.md`](overview.md) | System architecture at a glance (Mermaid diagram + narrative). |
| [`streaming-stack.md`](streaming-stack.md) | The LiveKit media pipeline (SFU + ingress + egress) and the ffmpeg/streamlink ingest paths. |
| [`viewbot-fleet.md`](viewbot-fleet.md) | The two live viewbot ingest paths (URL relay + local video) over LiveKit ingress, and the rotation gating. |
| [`realtime-events.md`](realtime-events.md) | Every socket event with direction and purpose (no WebRTC handshake — that's inside LiveKit). |
| [`data-model.md`](data-model.md) | Key DB tables, relationships, lifecycle, and the migration runner. |
| [`schema-actual.sql`](schema-actual.sql) | Live `.schema` dump from the production DB — source of truth for what columns actually exist. |
| [`background-work.md`](background-work.md) | Every `setInterval` / `setTimeout` / child-process site, lifecycle-ready vs leaked. |
| [`service-catalog.md`](service-catalog.md) | The ~150 backend services in `/server/services/` (+ subdirectory modules), grouped thematically. |
| [`adr/`](adr/) | Architecture Decision Records — append-only. |

The `plans/` subfolder holds active feature plans (e.g. `url-relay-whitelist-mode.md`); completed roadmaps/handoffs and the point-in-time `socket-events-actual.md` inventory were moved to [`/docs/archive/plans/`](../archive/plans/).
