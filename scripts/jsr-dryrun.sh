#!/usr/bin/env bash
# Local JSR publish dry-run helper.
#
# `types/` is git-ignored (build artifacts, never committed), but JSR's
# underlying `deno publish` honors `.gitignore` and would otherwise drop the
# generated declarations. CI un-ignores `types/` at publish time (see
# `.github/workflows/publish.yml`); this script does the same for a local
# dry-run and restores `.gitignore` exactly as it was on exit.
#
# Usage:
#   scripts/jsr-dryrun.sh                 # dry-run every package
#   scripts/jsr-dryrun.sh core            # dry-run one package
#                                            (core|node|webrtc-node|websocket-server-node)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GITIGNORE="$ROOT/.gitignore"
NEGLINE="!packages/*/types/**"

# Snapshot .gitignore so we can restore it verbatim (even on error / Ctrl-C).
backup="$(mktemp)"
cp "$GITIGNORE" "$backup"
trap 'cp "$backup" "$GITIGNORE"; rm -f "$backup"' EXIT

# Un-ignore the generated declarations for the duration of this run.
grep -qxF "$NEGLINE" "$GITIGNORE" || printf '\n%s\n' "$NEGLINE" >> "$GITIGNORE"

# Regenerate declarations so the dry-run reflects current source.
(cd "$ROOT" && npm run types --workspaces --if-present) >/dev/null

packages=("$@")
if [ "${#packages[@]}" -eq 0 ]; then
  packages=(core node webrtc-node websocket-server-node)
fi

for p in "${packages[@]}"; do
  if [ ! -f "$ROOT/packages/$p/jsr.json" ]; then
    echo "::error::Unknown package '$p' (expected one of: core node webrtc-node websocket-server-node)" >&2
    exit 1
  fi
  echo "=== @reticulum/$p ==="
  (cd "$ROOT/packages/$p" && npx -y jsr publish --dry-run --allow-dirty)
done
