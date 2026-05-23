# Architecture

The "why" behind the system shape. ADRs in [`adr/`](adr/) capture historical decisions.

| File | Covers |
|------|--------|
| [`overview.md`](overview.md) | System architecture at a glance (Mermaid diagram + 5-bullet narrative). |
| [`streaming-stack.md`](streaming-stack.md) | The MediaSoup + GStreamer + ffmpeg + LiveKit interplay. |
| [`viewbot-fleet.md`](viewbot-fleet.md) | Why ~20 viewbot variants exist; which one is live. |
| [`realtime-events.md`](realtime-events.md) | All ~110 socket events with direction and purpose. |
| [`data-model.md`](data-model.md) | Key DB tables, relationships, and lifecycle. |
| [`service-catalog.md`](service-catalog.md) | The ~100 backend services in /server/services/, grouped thematically. |
| [`adr/`](adr/) | Architecture Decision Records — append-only. |
