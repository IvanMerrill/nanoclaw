#!/bin/bash
# System-level maintenance: update mise runtimes, prune Docker, check disk.
#
# Runs daily via launchd. Lightweight — no Claude session needed.

set -euo pipefail

LOG_PREFIX="[system-maint]"
log() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"; }

export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
export HOME="${HOME:-/Users/ivan}"

# ---- mise: update Node and other runtimes ----
if command -v mise &>/dev/null; then
  log "Updating mise runtimes..."
  mise upgrade --yes 2>&1 || log "WARN: mise upgrade failed"
  mise prune --yes 2>&1 || true
else
  log "mise not found, skipping runtime updates"
fi

# ---- Docker: prune unused images/containers ----
if command -v docker &>/dev/null; then
  log "Pruning Docker..."
  docker system prune -f --filter "until=168h" 2>&1 || log "WARN: Docker prune failed"
else
  log "Docker not found, skipping prune"
fi

# ---- Disk space check ----
AVAIL_GB=$(df -g / | tail -1 | awk '{print $4}')
if [ "$AVAIL_GB" -lt 20 ]; then
  log "WARNING: Only ${AVAIL_GB}GB free disk space!"
else
  log "Disk space: ${AVAIL_GB}GB free"
fi

log "System maintenance complete."
