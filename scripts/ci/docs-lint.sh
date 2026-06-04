#!/usr/bin/env bash
#
# Docs + secret-hygiene gate. Ported verbatim from the retired GitHub Actions
# `docs-lint` job (.github/workflows/ci.yml) so the invariants keep running
# under CircleCI. Invoked by the `lint` job. Exits non-zero on any violation.
#
# Three checks:
#   1. Only the six allowed markdown files live at the repo root.
#   2. No "Status: ... stub" placeholder docs remain (outside docs/archive).
#   3. No committed SendGrid-shaped secrets (SG.xxxxx…) in tracked sources.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2   # repo root
fail=0

echo "== [1/3] root markdown hygiene =="
allowed='README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md LICENSE CLAUDE.md'
found=$(ls -1 ./*.md ./*.MD 2>/dev/null | sed 's#^\./##' || true)
if [ -n "$found" ]; then
  unexpected=""
  for f in $found; do
    case " $allowed " in
      *" $f "*) ;;
      *) unexpected="$unexpected $f" ;;
    esac
  done
  if [ -n "$unexpected" ]; then
    echo "ERROR: unexpected .md files at repo root:$unexpected"
    echo "       Only [$allowed] are allowed at root; move others to /docs/."
    fail=1
  fi
fi

echo "== [2/3] no stub docs =="
if grep -rn "Status:.*stub" docs/ --include='*.md' --exclude-dir=archive; then
  echo "ERROR: docs contain 'Status: … stub' markers — fill them in or remove the placeholder."
  fail=1
fi

echo "== [3/3] no committed SendGrid-shaped secrets =="
if grep -rnE "SG\.[A-Za-z0-9_-]{20,}" \
      --include='*.js' --include='*.ts' --include='*.json' --include='*.md' \
      --exclude-dir=node_modules --exclude-dir=archive \
      . | grep -v "docs/operations/runbooks/secret-rotation.md"; then
  echo "ERROR: found SendGrid-shaped key in committed files."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "docs-lint: FAILED"
  exit 1
fi
echo "docs-lint: OK"
