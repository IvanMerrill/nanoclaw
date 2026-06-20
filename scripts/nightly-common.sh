#!/bin/bash
# Shared functions for nightly maintenance scripts.
# Source this file, don't run it directly.
#
# Required variables (set before sourcing):
#   PROJECT_ROOT  — absolute path to the nanoclaw project root
#   LOG_PREFIX    — e.g. "[upstream-sync]"
#   JOB_NAME      — e.g. "upstream-sync" (used for worktree naming)

# --- Environment setup ---

export HOME="${HOME:-/Users/ivan}"

# Activate mise to put node/npm/claude in PATH.
# Use the shim binary directly — it is version-independent.
MISE_SHIM="$HOME/.local/share/mise/shims/mise"
if [ -x "$MISE_SHIM" ]; then
  eval "$("$MISE_SHIM" env 2>/dev/null)" || true
elif command -v mise &>/dev/null; then
  eval "$(mise env 2>/dev/null)" || true
fi

# Ensure shims dir and homebrew are in PATH as fallback
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# --- Functions ---

log() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Deliver a notification into the live v2 message flow.
#
# v2 has no IPC drop path — the old store/messages.db lookup and the
# data/ipc/.../messages/*.json files are v1 vestiges that nothing reads.
# scripts/notify-main-chat.ts resolves the active Telegram session from
# data/v2.db and writes a messages_out row; the host delivery sweep picks it
# up and sends it through the Telegram adapter (works even when no container
# is running, because the session stays status='active').
notify_ren() {
  local message="$1"
  local output status=0
  # `|| status=$?` keeps the failure inside a list so `set -e` in the calling
  # nightly scripts can't abort the whole job just because a notification failed.
  output=$(cd "$PROJECT_ROOT" && pnpm exec tsx scripts/notify-main-chat.ts "$message" 2>&1) || status=$?
  [ -n "$output" ] && log "$output"
  if [ "$status" -ne 0 ]; then
    log "WARN: notify_ren delivery failed (exit $status)"
    return 1
  fi
}

setup_worktree() {
  WORKTREE_DIR="$PROJECT_ROOT/.worktrees/${JOB_NAME}-$(date +%Y%m%d-%H%M%S)"
  WORKTREE_BRANCH="${JOB_NAME}-$(date +%Y%m%d)"
  mkdir -p "$(dirname "$WORKTREE_DIR")"

  # Clean up any stale branch from a previous failed run today
  git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
  git -C "$PROJECT_ROOT" branch -D "$WORKTREE_BRANCH" 2>/dev/null || true

  log "Creating worktree at $WORKTREE_DIR..."
  git -C "$PROJECT_ROOT" worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_DIR" main 2>&1
}

cleanup_worktree() {
  if [ -n "${WORKTREE_DIR:-}" ] && [ -d "$WORKTREE_DIR" ]; then
    log "Cleaning up worktree..."
    git -C "$PROJECT_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
  fi
  if [ -n "${WORKTREE_BRANCH:-}" ]; then
    git -C "$PROJECT_ROOT" branch -D "$WORKTREE_BRANCH" 2>/dev/null || true
  fi
  git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
}

push_and_pull() {
  log "Pushing changes to origin..."
  git -C "$WORKTREE_DIR" push origin "${WORKTREE_BRANCH}:main" 2>&1
  log "Pulling into main working directory..."
  git -C "$PROJECT_ROOT" pull --ff-only origin main 2>&1 || log "WARN: pull --ff-only failed (main tree may have local changes)"
}

rebuild_container() {
  log "Rebuilding container image..."
  CONTAINER_RUNTIME=docker "$PROJECT_ROOT/container/build.sh" 2>&1
}

restart_and_verify() {
  local commit_desc="${1:-}"

  log "Restarting Ren..."
  launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
  sleep 8

  if pgrep -f "node.*dist/index.js" > /dev/null 2>&1; then
    log "Ren started successfully."
    return 0
  fi

  log "ERROR: Ren failed to start after update. Rolling back..."
  cd "$PROJECT_ROOT"
  git revert HEAD --no-edit 2>&1
  # Host is pnpm-managed; the revert restores pnpm-lock.yaml, so a frozen
  # install reproduces the pre-update state exactly.
  pnpm install --frozen-lockfile 2>&1
  pnpm run build 2>&1
  git push origin main 2>&1
  launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"
  sleep 8

  if pgrep -f "node.*dist/index.js" > /dev/null 2>&1; then
    notify_ren "$(printf '⚠️ *Nightly update rolled back*\n\nThe update from last night broke my startup. I reverted the commit and I am running again, but you should review what went wrong.\n\n%s\n\nCheck logs for details.' "$commit_desc")"
    log "Rollback successful — Ren is running again."
  else
    log "CRITICAL: Ren failed to start even after rollback. Manual intervention required."
  fi
  return 1
}
