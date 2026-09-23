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
  # Deliberately aggressive: images and build cache are rebuildable, and disk is
  # the scarce resource on this box. An "until=168h" filter was tried first and
  # was structurally unable to fire — the agent image rebuilds nightly, so every
  # cache entry is always younger than the cutoff. It had silently grown back to
  # 51 entries / 14.9GB before that was spotted.
  #
  # Volumes are deliberately NOT pruned: they hold state, not rebuildable
  # artifacts, and a briefly-stopped container would lose its data.
  docker container prune -f 2>&1 || log "WARN: Docker container prune failed"
  # -a drops every image without a running container. The live Ren image is
  # protected by being in use.
  docker image prune -af 2>&1 || log "WARN: Docker image prune failed"
  docker builder prune -af 2>&1 || log "WARN: Docker builder prune failed"
else
  log "Docker not found, skipping prune"
fi

# ---- Homebrew: cleanup + abandoned cask staging ----
if command -v brew &>/dev/null; then
  log "Cleaning up Homebrew..."
  brew cleanup --prune=all 2>&1 || log "WARN: brew cleanup failed"
  # homebrew-autoupdate stages a full .app here on every cask upgrade and never
  # removes it (12.8GB of old Docker Desktop builds by the time this was added).
  # brew cleanup does not reach it. Only touch entries idle 3+ days so an
  # in-flight install is never pulled out from under itself.
  STAGING="$(brew --prefix)/var/homebrew/tmp/.caskroom"
  if [ -d "$STAGING" ]; then
    find "$STAGING" -mindepth 2 -maxdepth 2 -mtime +1 -exec rm -rf {} + 2>/dev/null || true
    find "$STAGING" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true
  fi
else
  log "brew not found, skipping Homebrew cleanup"
fi

# ---- npm cache: unbounded by default, reached 9.7GB ----
if command -v npm &>/dev/null; then
  NPM_CACHE_MB=$(du -x -s -m "$HOME/.npm" 2>/dev/null | cut -f1 || echo 0)
  if [ "${NPM_CACHE_MB:-0}" -gt 512 ]; then
    log "npm cache is ${NPM_CACHE_MB}MB, clearing..."
    npm cache clean --force 2>&1 || log "WARN: npm cache clean failed"
  fi
fi

# ---- Disk space check ----
AVAIL_GB=$(df -g / | tail -1 | awk '{print $4}')
if [ "$AVAIL_GB" -lt 20 ]; then
  log "WARNING: Only ${AVAIL_GB}GB free disk space!"
else
  log "Disk space: ${AVAIL_GB}GB free"
fi

log "System maintenance complete."
