#!/usr/bin/env bash
# Run each *.bettersqlite.test.js suite in its OWN jest process.
#
# The two better-sqlite3 contract suites corrupt each other's error handling
# when they share a worker process (better-sqlite3 stops throwing) — and
# jest's in-band heuristic can put both files in ONE process even with
# --maxWorkers=2 once the cached timings say the run is fast. Probe-verified
# NOT the node-sqlite3 co-load class (neither file requires database.js);
# see the 2026-07 audit follow-ups and ADR-0014.
#
# Extra args (e.g. --reporters=...) are passed through to every jest run.
# JEST_JUNIT_OUTPUT_NAME is set per-suite so junit outputs don't clobber.
set -euo pipefail
cd "$(dirname "$0")/../.."

status=0
found=0
while IFS= read -r f; do
  found=1
  name="$(basename "$f" .test.js)"
  echo "=== bettersqlite (isolated process): $f ==="
  if ! JEST_JUNIT_OUTPUT_NAME="${name}.junit.xml" \
      npx jest --config config/jest/jest.bettersqlite.config.js --runTestsByPath "$f" "$@"; then
    status=1
  fi
done < <(find server chat-service -path '*/node_modules' -prune -o -name '*.bettersqlite.test.js' -print | sort)

if [ "$found" -eq 0 ]; then
  echo "ERROR: no *.bettersqlite.test.js files found" >&2
  exit 1
fi
exit "$status"
