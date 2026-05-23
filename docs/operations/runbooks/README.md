# Runbooks

A runbook is what we wish we had at 2 a.m. the first time a production issue happened. **Add one whenever you debug something gnarly enough that future-you or a teammate would benefit from skipping the diagnosis.**

## Template

Copy this when creating a new runbook (filename `runbook-name.md`):

~~~markdown
# <Incident class — short and grep-friendly>

_Last verified: YYYY-MM-DD against commit <sha>._

## Symptoms
What the operator sees first — exact error message, user report, alert text.

## How to confirm
The fastest probe(s) that prove this is the issue (not a similar-looking one).

## Likely causes
Ranked by probability. Each one maps to a Resolution step below.

## Resolution
Step-by-step. Include exact commands, file paths, restart procedures, and rollback steps.

## Prevention
What would have prevented this. Could be code, monitoring, runbook update, etc.
~~~

## Existing runbooks

| File | Covers |
|------|--------|
| [`stream-stuck.md`](stream-stuck.md) | Stream appears live in UI but no video reaches viewers. |
| [`livekit-disconnect.md`](livekit-disconnect.md) | LiveKit clients failing to connect or dropping. |
| [`recording-upload-failed.md`](recording-upload-failed.md) | Recording segments not appearing in B2. |
| [`viewbot-fleet-misbehaving.md`](viewbot-fleet-misbehaving.md) | Viewbot rotation hung, leaking processes, or stuck on one channel. |
| [`secret-rotation.md`](secret-rotation.md) | Procedure for rotating any of the project's credentials. |
