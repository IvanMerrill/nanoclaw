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

# Ensure shims dir and homebrew are in PATH as fallback.
# bun is NOT managed by mise and lives in ~/.bun/bin — without it the
# container gates (container-typecheck deps, agent-runner-tests) fail with
# "bun: command not found" under the minimal launchd PATH.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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
    chmod -R u+rwx "$WORKTREE_DIR" 2>/dev/null || true
    chflags -R nouchg,noschg "$WORKTREE_DIR" 2>/dev/null || true   # macOS: clear any immutable flags
    git -C "$PROJECT_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null
    # The e2e gate's container can leave files owned by a uid the host user
    # can't delete (Docker Desktop file sharing). Nuke them via a throwaway
    # container running as root — uses the LOCAL image, so no docker.io pull.
    if [ -d "$WORKTREE_DIR" ]; then
      docker run --rm --user 0:0 --entrypoint rm \
        -v "$(dirname "$WORKTREE_DIR")":/wt \
        "$(image_base):latest" -rf "/wt/$(basename "$WORKTREE_DIR")" 2>/dev/null || true
      rm -rf "$WORKTREE_DIR" 2>/dev/null || true
    fi
    git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
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

# The slug-scoped base image name for this install (e.g. nanoclaw-agent-v2-98989602).
# The install slug is sha1(project root)[:8], so a worktree at a different path
# would resolve a DIFFERENT slug. We pin it to the live install root via
# NANOCLAW_PROJECT_ROOT so build / e2e / promote all agree on the image the
# running host actually uses.
image_base() {
  ( NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT" source "$PROJECT_ROOT/setup/lib/install-slug.sh" && container_image_base )
}

# Run a command with a wall-clock timeout (macOS has no `timeout` binary).
# Returns 124 if it had to be killed. Detaches the client on timeout — a
# server-side buildkit build may continue, but the gate fails fast instead of
# hanging the whole pipeline (Docker Desktop's registry proxy can wedge).
with_timeout() {
  local secs="$1"; shift
  "$@" & local pid=$!
  ( sleep "$secs"; kill -0 "$pid" 2>/dev/null && { kill -TERM "$pid" 2>/dev/null; sleep 3; kill -KILL "$pid" 2>/dev/null; } ) & local wd=$!
  wait "$pid" 2>/dev/null; local rc=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  [ "$rc" -gt 128 ] && return 124
  return "$rc"
}

# Deterministic pre-deploy gate stack. Runs every check that stands between an
# update and production, in an isolated worktree against an isolated image tag.
# Args: <worktree_root> <candidate_image_tag> <rebuild_image: true|false>
# On failure: sets GATE_FAILED to the failing gate name and returns 1.
#
# Image handling: when rebuild_image=true (the container tree changed) the image
# is built as <base>:<tag> and the e2e smoke runs against THAT candidate, so the
# live <base>:latest is never touched until promote_image() on deploy. When
# rebuild_image=false (host-only night) we skip the build entirely — no docker.io
# pull — and run the e2e against the existing <base>:latest.
#
# The slow Docker gates are wrapped in with_timeout so a wedged registry proxy
# fails the gate in minutes instead of hanging the pipeline.
GATE_FAILED=""
GATE_IMAGE_BUILD_TIMEOUT="${GATE_IMAGE_BUILD_TIMEOUT:-1800}"   # 30 min
GATE_E2E_TIMEOUT="${GATE_E2E_TIMEOUT:-300}"                    # 5 min
run_gates() {
  local root="$1" img_tag="$2" rebuild_image="${3:-true}"
  local base; base="$(image_base)"
  GATE_FAILED=""

  _gate() {
    local name="$1"; shift
    log "GATE → $name"
    if "$@"; then
      log "GATE ✓ $name"
      return 0
    fi
    GATE_FAILED="$name"
    log "GATE ✗ $name"
    return 1
  }

  # The gate stack must install exactly what it tests, from the lockfiles — a
  # fresh worktree has no node_modules in any tree, and we don't want the gates
  # to silently rely on an earlier phase's install side-effects (that breaks
  # --gates-only and any no-op night). Materialize host (pnpm) and container
  # (Bun) deps up front; without the container tree, tsc can't resolve
  # `@types/bun` (TS2688) and `bun test` has nothing to run against.
  _gate "host-deps"             bash -c "cd '$root' && pnpm install --frozen-lockfile" || return 1
  _gate "container-deps"        bash -c "cd '$root/container/agent-runner' && bun install --frozen-lockfile" || return 1
  _gate "google-mcp-deps"       bash -c "cd '$root/container/nanoclaw-google-mcp' && npm ci" || return 1
  _gate "host-typecheck+build"  bash -c "cd '$root' && pnpm run build" || return 1
  _gate "container-typecheck"   bash -c "cd '$root' && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit" || return 1
  _gate "google-mcp-build"      bash -c "cd '$root/container/nanoclaw-google-mcp' && npm run build" || return 1
  _gate "host-tests"            bash -c "cd '$root' && pnpm test" || return 1
  _gate "agent-runner-tests"    bash -c "cd '$root/container/agent-runner' && bun test" || return 1
  _gate "google-mcp-tests"      bash -c "cd '$root/container/nanoclaw-google-mcp' && npm test" || return 1

  local e2e_image
  if [ "$rebuild_image" = "true" ]; then
    _gate "container-image-build" with_timeout "$GATE_IMAGE_BUILD_TIMEOUT" \
      env NANOCLAW_PROJECT_ROOT="$PROJECT_ROOT" CONTAINER_RUNTIME=docker bash -c "cd '$root' && ./container/build.sh '$img_tag'" || return 1
    e2e_image="${base}:${img_tag}"
  else
    log "GATE — container-image-build SKIPPED (container tree unchanged; e2e runs against live :latest)"
    e2e_image="${base}:latest"
  fi

  _gate "e2e-smoke" with_timeout "$GATE_E2E_TIMEOUT" \
    env CONTAINER_IMAGE="$e2e_image" bash -c "cd '$root' && pnpm exec tsx scripts/test-v2-host.ts" || return 1

  log "ALL GATES PASSED"
  return 0
}

# Promote the gate-tested candidate image to the live :latest tag.
promote_image() {
  local img_tag="$1"
  local base; base="$(image_base)"
  log "Promoting ${base}:${img_tag} → ${base}:latest"
  docker tag "${base}:${img_tag}" "${base}:latest"
}
