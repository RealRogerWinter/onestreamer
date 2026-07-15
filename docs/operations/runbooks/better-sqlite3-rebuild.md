# better-sqlite3 — native binding rebuild

_Last verified: 2026-05-27 against commit on `better-sqlite3-adapter` (PR 5.2)._

## Symptoms

On boot or first `npm install`, the structured log shows:

```
better-sqlite3 adapter failed to load; falling back to sqlite3
  err: Error: The module '.../better_sqlite3.node' was compiled against a
       different Node.js version using NODE_MODULE_VERSION X. This version
       of Node.js requires NODE_MODULE_VERSION Y.
```

The server keeps running via the sqlite3 fallback — but since the
ADR-0014 Phase-C flip, better-sqlite3 is the DEFAULT driver, so a load
failure now **silently downgrades the default**. Treat the
`better-sqlite3 adapter failed to load; falling back to sqlite3` log line
as an incident signal, and check for the `better-sqlite3 adapter active`
line as part of deploy verification.

## How to confirm

```bash
node -e "require('better-sqlite3')" 2>&1 | head -3
```

If the output includes `ERR_DLOPEN_FAILED` + `NODE_MODULE_VERSION`, it's
this issue.

```bash
node -e "console.log(process.versions.modules)"
# Compare against the version the pre-built binary expects (from the error message).
```

## Likely causes

1. **Ubuntu noble (24.04) ships Node 18.19.1 with a downstream `NODE_MODULE_VERSION` of 109**, while pristine Node 18.x from nodejs.org uses 108. better-sqlite3's pre-built tarballs target the pristine NMV, so they fail to load on the patched binary.
2. Node version bump on the host (e.g. moved from 18.x to 20.x) without re-running `npm rebuild`.
3. `node_modules/better-sqlite3/build/Release/better_sqlite3.node` was checked into a backup that came from a different machine.

## Resolution

**First — verify the rebuild is actually needed.** Stock Node 18.0–18.18 from
nodejs.org carries NMV=108, Node 18.19+ patched by Ubuntu noble (and other
downstream distros) carries NMV=109, and Node 20+ carries NMV=115. The
better-sqlite3 pre-built binaries target specific NMVs; mismatch is the
trigger. If your `process.versions.modules` already matches what the
pre-built binary expects, the rebuild is a no-op and you should investigate
something else.

```bash
node -e "console.log('runtime NMV:', process.versions.modules)"
# Compare against the error message — "compiled against X" should match.
```

If they match but the binding still won't load, you're hitting a different
problem (glibc mismatch, missing libstdc++, etc.) — `ldd` against the
binary is the next probe.

If they DON'T match, rebuild from source against the **system** Node
headers (not the node-gyp-cached ones from nodejs.org, which carry the
pristine NMV):

```bash
cd /root/onestreamer
# Verify the headers carry your runtime's NMV before rebuilding.
grep "NODE_MODULE_VERSION " /usr/include/nodejs/src/node_version.h
# Expect a line ending in your runtime NMV (e.g. "109" on Ubuntu noble).

sudo apt install -y libnode-dev node-gyp        # one-time
cd node_modules/better-sqlite3
rm -rf build
node-gyp rebuild --nodedir=/usr/include/nodejs
```

On Ubuntu, `/usr/include/nodejs/src/node_version.h` carries the
patched NMV that `/usr/bin/node` actually reports.

Verify:

```bash
cd /root/onestreamer
node -e "const Db = require('better-sqlite3'); const d = new Db(':memory:'); console.log(d.prepare('SELECT sqlite_version()').get()); d.close();"
# Expect: { 'sqlite_version()': '3.49.2' }   (or similar — engine version varies by better-sqlite3 release)
```

Restart the server:

```bash
pm2 restart onestreamer-server
pm2 logs onestreamer-server --lines 50 | grep -i 'better-sqlite3'
```

Expect to see the structured log line:

```
better-sqlite3 adapter active (default; set USE_BETTER_SQLITE3=false to opt out)
  walActive: true
  dbPath: /root/onestreamer/server/data/onestreamer.db
```

## Rollback

If the rebuild produces a binary that misbehaves at runtime:

```bash
# 1. Opt out of the default driver (container deploys: /etc/onestreamer/app.env;
#    the legacy pm2-era path was /root/onestreamer/.env).
echo 'USE_BETTER_SQLITE3=false' >> /etc/onestreamer/app.env
# then restart the container (or pm2 restart onestreamer-server on bare host)
```

The adapter loader catches its own errors, so even a broken binding
won't crash the server — but it will spam structured warnings on every
boot. Flipping the flag silences them.

To force a clean re-install of the npm package:

```bash
cd /root/onestreamer
rm -rf node_modules/better-sqlite3
npm install better-sqlite3@11
cd node_modules/better-sqlite3
rm -rf build
node-gyp rebuild --nodedir=/usr/include/nodejs
```

(Pin to `@11` for now — better-sqlite3@12 requires Node 20+ and won't
compile against the Node 18 headers.)

## Prevention

- **CI** should run `npm rebuild better-sqlite3 --build-from-source` if the
  pre-built binary doesn't match the runtime NMV. The check is one line in
  the workflow; it's a no-op on hosts where the pre-built binary works.
- **package.json** could carry a `postinstall` script for this — but that
  fires for every developer, including those on systems where the pre-built
  works. Documented manual rebuild is the right tradeoff at PR 5.2 scope.
- **Phase D rollout** (drop sqlite3, adapter becomes the only path)
  should not happen until either Node is upgraded past Ubuntu's NMV-109
  patch *or* the postinstall hook lands.
