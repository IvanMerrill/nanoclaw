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

resolve_main_chat_jid() {
  local db_path="$PROJECT_ROOT/store/messages.db"
  if [ ! -f "$db_path" ]; then
    log "WARN: Database not found at $db_path — notifications disabled"
    echo ""
    return
  fi
  /usr/bin/sqlite3 "$db_path" "SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1" 2>/dev/null || echo ""
}

notify_ren() {
  local message="$1"
  if [ -z "${MAIN_CHAT_JID:-}" ]; then
    log "WARN: No main chat JID — skipping notification"
    return
  fi
  local ipc_dir="$PROJECT_ROOT/data/ipc/telegram_main/messages"
  mkdir -p "$ipc_dir"
  local filename="nightly-$(date +%s)-$$.json"
  node -e "
    const fs = require('fs');
    const msg = { type: 'message', chatJid: process.argv[1], text: process.argv[2] };
    fs.writeFileSync(process.argv[3], JSON.stringify(msg));
  " "$MAIN_CHAT_JID" "$message" "$ipc_dir/$filename"
  log "Notification written to IPC: $filename"
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
  npm install 2>&1
  npm run build 2>&1
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
