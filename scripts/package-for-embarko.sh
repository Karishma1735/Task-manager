#!/usr/bin/env bash
# Builds a clean .tar.gz of exactly what should be uploaded to Embarko. LOCAL ONLY: no network, no upload.
# Usage: scripts/package-for-embarko.sh [output.tar.gz]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-/tmp/value-ledger-embarko.tar.gz}"

# tracked + untracked-but-not-ignored files; never node_modules/.next/.env*/databases (all git-ignored)
# Tests, e2e, docs and tooling configs are not needed to build or run the app.
git ls-files -co --exclude-standard \
  | grep -v -E '^(e2e/|tests/|docs/|playwright\.config\.ts|vitest\.config\.mts|tsconfig\.check\.json|\.env)' \
  | grep -v -E '\.(db|db-wal|db-shm|sqlite)$' \
  > /tmp/embarko-files.txt

# Safety net: refuse if anything secret-looking or database-like slipped in.
if grep -E '(^|/)\.env(\.|$)|\.db(-wal|-shm)?$|(^|/)data/' /tmp/embarko-files.txt; then
  echo "refusing: a secret or database file is in the package list" >&2; exit 1
fi
test -f embarko.json && test -f package.json && test -d drizzle || { echo "missing embarko.json, package.json or drizzle/" >&2; exit 1; }

tar -czf "$OUT" -T /tmp/embarko-files.txt
echo "wrote $OUT ($(wc -c < "$OUT") bytes, $(wc -l < /tmp/embarko-files.txt) files)"
tar -tzf "$OUT" | grep -E '^(embarko\.json|package\.json|package-lock\.json|drizzle/0000|src/instrumentation\.ts)$'
