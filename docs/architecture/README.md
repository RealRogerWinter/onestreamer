# Architecture

The "why" behind the system shape. ADRs in [`adr/`](adr/) capture historical decisions.

| File | Covers |
|------|--------|
| [`overview.md`](overview.md) | System architecture at a glance (Mermaid diagram + 5-bullet narrative). |
| [`streaming-stack.md`](streaming-stack.md) | The MediaSoup + GStreamer + ffmpeg + LiveKit interplay. |
| [`viewbot-fleet.md`](viewbot-fleet.md) | Why ~20 viewbot variants exist; which one is live. |
| [`realtime-events.md`](realtime-events.md) | All ~110 socket events with direction and purpose. |
| [`socket-events-actual.md`](socket-events-actual.md) | Mechanical site-level surface — which file:line emits or listens to what (companion to `realtime-events.md`). |
| [`data-model.md`](data-model.md) | Key DB tables, relationships, and lifecycle. |
| [`schema-actual.sql`](schema-actual.sql) | Live `.schema` dump from the production DB — source of truth for what columns actually exist. |
| [`background-work.md`](background-work.md) | Every `setInterval` / `setTimeout` / child-process site, lifecycle-ready vs leaked. |
| [`service-catalog.md`](service-catalog.md) | The ~100 backend services in /server/services/, grouped thematically. |
| [`adr/`](adr/) | Architecture Decision Records — append-only. |
