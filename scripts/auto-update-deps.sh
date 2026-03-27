#!/bin/bash
# Automated daily dependency update for NanoClaw.
#
# Updates all three package trees, builds, tests, and only commits +
# restarts if everything passes. Rolls back on any failure.
#
# Designed to run unattended via launchd. Logs to stdout (captured by launchd).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_PREFIX="[auto-update-deps]"
log() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Ensure we're on a clean working tree
if [ -n "$(git status --porcelain)" ]; then
  log "ERROR: Working tree is dirty. Skipping update."
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
BEFORE_SHA=$(git rev-parse HEAD)

log "Starting dependency update on branch $BRANCH ($BEFORE_SHA)"

# ---- Phase 1: Update dependencies ----

log "Updating host dependencies..."
npm update --save 2>&1

log "Updating container/agent-runner dependencies..."
(cd container/agent-runner && npm update --save 2>&1)

log "Updating container/nanoclaw-google-mcp dependencies..."
(cd container/nanoclaw-google-mcp && npm update --save 2>&1)

# Check if anything changed
if [ -z "$(git status --porcelain)" ]; then
  log "No dependency changes. Nothing to do."
  exit 0
fi

log "Dependencies changed — building and testing..."

# ---- Phase 2: Build ----

if ! npm run build 2>&1; then
  log "ERROR: Host build failed. Rolling back."
  git checkout -- .
  exit 1
fi

if ! (cd container/nanoclaw-google-mcp && npm run build 2>&1); then
  log "ERROR: Google MCP build failed. Rolling back."
  git checkout -- .
  exit 1
fi

# ---- Phase 3: Test ----

if ! npm test 2>&1; then
  log "ERROR: Host tests failed. Rolling back."
  git checkout -- .
  exit 1
fi

if ! (cd container/nanoclaw-google-mcp && npm test 2>&1); then
  log "ERROR: Google MCP tests failed. Rolling back."
  git checkout -- .
  exit 1
fi

log "All builds and tests passed."

# ---- Phase 4: Commit ----

git add -A
git commit -m "chore: automated dependency update $(date '+%Y-%m-%d')

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>" 2>&1

AFTER_SHA=$(git rev-parse HEAD)
log "Committed: $BEFORE_SHA → $AFTER_SHA"

# ---- Phase 5: Rebuild container ----

log "Rebuilding container image..."
if ! CONTAINER_RUNTIME=docker ./container/build.sh 2>&1; then
  log "ERROR: Container build failed. Reverting commit."
  git reset --hard "$BEFORE_SHA"
  exit 1
fi

# ---- Phase 6: Restart NanoClaw ----

log "Restarting NanoClaw..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>&1 || true

log "Done. Updated $BEFORE_SHA → $AFTER_SHA"
