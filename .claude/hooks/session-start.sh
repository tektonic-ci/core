#!/usr/bin/env bash
# SessionStart hook: makes a fresh checkout able to run the tests and the build.
#
# Written for Claude Code on the web, where the container is a cold clone with no
# Flox and no node_modules. Beads (bd install, database rebuild, merge driver,
# bd prime) is handled separately by .claude/hooks/beads-session-start.sh, which is
# vendored from pfenerty/planning and shared by every repo. SessionStart hooks run
# in parallel, so this script must not touch bd.
#
# Locally this is a no-op: Flox supplies node and the tree is usually already warm.
#
# Idempotent and non-interactive. Safe to re-run.
set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

# Never fail the session over setup. Each step reports and moves on.
note() { echo "[session-start] $*" >&2; }

# ── Node dependencies ────────────────────────────────────────────────────────
# Remote only. `npm install` (not `ci`) so the container snapshot taken after this
# hook is reusable across sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ ! -d node_modules ]; then
  if command -v npm >/dev/null 2>&1; then
    note "installing npm dependencies..."
    npm install --no-audit --no-fund >/dev/null 2>&1 \
      && note "npm dependencies installed" \
      || note "npm install failed"
  fi
fi

exit 0
