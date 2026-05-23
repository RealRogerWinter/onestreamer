# Adding a backend service

_Last verified: 2026-05-23 against commit 4a1d325._

Most OneStreamer features land as a new module in [`server/services/`](../../server/services/). The service catalog ([`/docs/architecture/service-catalog.md`](../architecture/service-catalog.md)) shows ~100 existing ones — this page is the recipe for adding a new one without making the catalog worse.

## What a service is

In OneStreamer, a "service" is a JS module that:

- Lives in `server/services/MyService.js` (PascalCase filename, one default-exported class or singleton)
- Encapsulates a specific responsibility (auth, recording, an LLM provider, etc.)
- Is instantiated once at server startup in [`server/index.js`](../../server/index.js) and made available globally (typically via `global.myService = new MyService()`)
- Holds its own state in memory; persists to SQLite when needed
- Owns its own scheduled work (intervals, watchers) and cleans them up on shutdown

This pattern is heavy on the global singleton — not the prettiest dependency injection, but it's what the codebase uses consistently. Match the convention.

## Recipe

### 1. Create the file

```js
// server/services/MyService.js

class MyService {
  constructor(options = {}) {
    this.options = options;
    this.state = new Map();
    // Wire up any sub-services or dependencies
  }

  async initialize() {
    // One-time setup: load from DB, kick off timers, etc.
  }

  // Public methods (the service's API)
  doTheThing(input) {
    // ...
  }

  // Internal helpers
  _internalHelper() {
    // ...
  }

  async shutdown() {
    // Clean up intervals, close connections, etc.
    if (this.tickInterval) clearInterval(this.tickInterval);
  }
}

module.exports = MyService;
```

### 2. Register in server/index.js

Near other service registrations (search for `new StreamService()` to find the cluster):

```js
const MyService = require('./services/MyService');

// ... in initialization block:
const myService = new MyService({ /* config */ });
await myService.initialize();
global.myService = myService;
console.log('✅ MyService initialized');
```

If your service needs to be reachable from other modules without circular imports, the `global.X` pattern is what the codebase uses. Yes, it's globals. Yes, the codebase already lives with it. Don't fight it.

### 3. Wire up graceful shutdown

In the existing SIGINT/SIGTERM handler in `server/index.js`:

```js
process.on('SIGTERM', async () => {
  // ... existing shutdown calls
  if (global.myService) await global.myService.shutdown();
});
```

Without this, intervals will keep running after the server stops, which PM2 will eventually nuke but with messier logs.

### 4. Add HTTP routes (if needed)

If your service needs an HTTP surface, create `server/routes/my-feature.js`:

```js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

router.get('/api/my-feature/status', async (req, res) => {
  try {
    const result = await global.myService.getStatus();
    res.json(result);
  } catch (err) {
    console.error('MyService status error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

router.post('/api/my-feature/action', authenticateToken, async (req, res) => {
  // ...
});

module.exports = router;
```

Register in `server/index.js`:

```js
app.use(require('./routes/my-feature'));
```

Document the new endpoints in [`/docs/api/rest.md`](../api/rest.md).

### 5. Add socket events (if needed)

In the relevant `socket.on('event', ...)` block in `server/index.js`:

```js
socket.on('my-feature:action', async (data) => {
  try {
    const result = await global.myService.doTheThing(data);
    socket.emit('my-feature:result', result);
  } catch (err) {
    socket.emit('my-feature:error', { error: err.message });
  }
});
```

Document in [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) and [`/docs/api/socket-events.md`](../api/socket-events.md).

### 6. Persistence (if needed)

If you need a new SQLite table:

1. Write a migration in `server/migrations/setup-my-feature-tables.js`:

   ```js
   const db = require('../database/database');
   
   db.serialize(() => {
     db.run(`
       CREATE TABLE IF NOT EXISTS my_feature_things (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER REFERENCES users(id),
         payload JSON,
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )
     `);
     console.log('✅ my_feature_things table created');
   });
   ```

2. Also add the table creation to [`server/database/database.js`](../../server/database/database.js) so fresh installs get it without running the migration manually.

3. Document the table in [`/docs/architecture/data-model.md`](../architecture/data-model.md).

### 7. Tests

If the service handles money / points / privileges / data integrity, add unit tests under `server/tests/`. See [`testing.md`](testing.md).

### 8. Documentation

Add an entry to [`/docs/architecture/service-catalog.md`](../architecture/service-catalog.md). Pick the right thematic group; don't create a one-service category unless it really doesn't fit anywhere.

If your service is a new user-visible feature, add a `/docs/features/<feature>.md`. If it's an integration with an external service, add a `/docs/integrations/<provider>.md`. If it changes the architecture, write an ADR.

## Anti-patterns to avoid

- **Don't create a new top-level `server/services/<NewGroup>/` directory.** The only existing example is `server/services/game/`, and that's because the game subsystem is genuinely self-contained.
- **Don't add a new service that just wraps an existing one for "convenience".** Add methods to the existing service instead.
- **Don't add `*.backup-<timestamp>.js` files.** Git is your backup.
- **Don't add `Simple<Thing>.js` and `<Thing>V2.js` and `<Thing>V3.js` variants.** The viewbot fleet is a cautionary tale ([`viewbot-fleet.md`](../architecture/viewbot-fleet.md)) — supersede in place.
- **Don't make the service do too much.** If your service has 1,500+ lines, it's probably two services.
- **Don't skip the catalog entry.** The catalog is how future contributors know your service exists.

## Naming

| Pattern | Use for |
|---------|---------|
| `<Thing>Service.js` | Most services — the dominant pattern |
| `<Thing>Manager.js` | Services that manage a fleet of similar things (ViewBotManager, ProcessManager) |
| `<Thing>Scheduler.js` | Services that own a periodic loop (AccountDeletionScheduler, RecordingUploadScheduler) |
| `<Thing>Adapter.js` | Abstraction over multiple implementations (WebRTCAdapter) |

## Checklist

Before opening a PR for a new service:

- [ ] File created at `server/services/<Name>.js`
- [ ] Registered in `server/index.js`
- [ ] Shutdown handler added
- [ ] Documented in [`service-catalog.md`](../architecture/service-catalog.md)
- [ ] If it has HTTP routes — documented in [`/docs/api/rest.md`](../api/rest.md)
- [ ] If it has socket events — documented in [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) and [`/docs/api/socket-events.md`](../api/socket-events.md)
- [ ] If it has DB tables — migration script + [`data-model.md`](../architecture/data-model.md) entry
- [ ] If it's a user-facing feature — `/docs/features/<feature>.md` page
- [ ] If it's an external dependency — `/docs/integrations/<provider>.md` page
- [ ] If it's a non-trivial design choice — an ADR
- [ ] Tests for any privilege/money/data-integrity-handling code paths
- [ ] CHANGELOG entry under `## [Unreleased]`

## See also

- [`coding-conventions.md`](coding-conventions.md) — style and file layout
- [`/docs/architecture/service-catalog.md`](../architecture/service-catalog.md) — the existing catalog
- [`/docs/architecture/data-model.md`](../architecture/data-model.md) — how DB tables get documented
- [`/docs/architecture/realtime-events.md`](../architecture/realtime-events.md) — how socket events get documented
