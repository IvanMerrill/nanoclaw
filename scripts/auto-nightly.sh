#!/bin/bash
# Unified nightly "keep Ren current" pipeline.
#
# One ordered run, in an isolated worktree, that updates everything Ren needs,
# proves it works through a deterministic gate stack, and only then deploys —
# committing to the fork, promoting the tested image, and restarting Ren. On
# any gate failure it discards the worktree and notifies; nothing red ever ships.
#
# Layers updated (in order):
#   1. Upstream framework + shared deps  → /update-nanoclaw (tracks upstream)
#   2. Channel adapters + providers      → /update-skills   (tracks their branches)
#   3. Local-only deps (full-auto, incl. majors): host (pnpm, 3-day gate),
#      agent-runner (bun), google-mcp (npm) — gates are the safety net.
#
# Gate stack (scripts/nightly-common.sh run_gates): host+container typecheck,
# google-mcp build, host/agent-runner/google-mcp tests, isolated container
# image build, real host→container→Claude→delivery e2e smoke.
#
# Usage:
#   ./scripts/auto-nightly.sh            # full run
#   ./scripts/auto-nightly.sh --dry-run  # update + gates, NO deploy (discards worktree)
#   ./scripts/auto-nightly.sh --gates-only  # just run the gate stack against a fresh worktree

set -uo pipefail   # not -e: we handle failures explicitly so a notify can fire

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PREFIX="[nightly]"
JOB_NAME="nightly"
CANDIDATE_TAG="nightly-test"

source "$PROJECT_ROOT/scripts/nightly-common.sh"

DRY_RUN=false
GATES_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --gates-only) GATES_ONLY=true ;;
  esac
done

CLAUDE_TOOLS="Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Skill"
CLAUDE_PHASE_TIMEOUT="${CLAUDE_PHASE_TIMEOUT:-2400}"   # 40 min per agent phase
run_claude() {
  # $1 = phase label, $2 = prompt. Tees to the nightly log. Timeout-wrapped so a
  # stuck agent session can't hang the pipeline; the gate stack is the real
  # safety net regardless of what these phases produce.
  local label="$1" prompt="$2"
  log "Claude phase: $label"
  with_timeout "$CLAUDE_PHASE_TIMEOUT" \
    bash -c "cd '$WORKTREE_DIR' && claude -p \"\$1\" --allowedTools '$CLAUDE_TOOLS'" _ "$prompt" \
    2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log"
  local rc=${PIPESTATUS[0]}
  [ "$rc" = 124 ] && log "WARN: Claude phase '$label' timed out after ${CLAUDE_PHASE_TIMEOUT}s"
  return 0   # never fatal — gates decide what's safe
}

setup_worktree
trap cleanup_worktree EXIT

# Worktrees don't carry the gitignored .env, but the gate stack needs it: the
# e2e smoke reads ONECLI_URL (the local gateway — without it the OneCLI SDK
# falls back to the cloud API and 401s), and container/build.sh reads build
# args (INSTALL_CJK_FONTS, etc.).
cp "$PROJECT_ROOT/.env" "$WORKTREE_DIR/.env" 2>/dev/null && log "copied .env into worktree" || log "WARN: no .env to copy into worktree"

# ---------------------------------------------------------------------------
# Phase 1 — Upstream framework + shared deps (tracks upstream)
# ---------------------------------------------------------------------------
if [ "$GATES_ONLY" = false ]; then
  log "Phase 1: upstream sync"
  git -C "$PROJECT_ROOT" fetch upstream 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log" || log "WARN: upstream fetch failed"
  NEW_COMMITS=$(git -C "$PROJECT_ROOT" rev-list --count "HEAD..upstream/main" 2>/dev/null || echo 0)
  log "Upstream has $NEW_COMMITS new commit(s)"
  if [ "$NEW_COMMITS" != "0" ]; then
    run_claude "update-nanoclaw" "Run /update-nanoclaw to bring upstream changes into this customized install. Work entirely inside $WORKTREE_DIR. Apply only changes relevant to how this install is used (Telegram, not WhatsApp; Google MCP). Reconcile dependency versions toward upstream's. Do NOT push, restart, or deploy — just leave the reconciled changes in the worktree. Do not run the gate stack; the pipeline does that."
  fi

  # -------------------------------------------------------------------------
  # Phase 2 — Channel adapters + providers (tracks their branches)
  # -------------------------------------------------------------------------
  log "Phase 2: skills update"
  run_claude "update-skills" "Run /update-skills to re-apply installed skills and pull their latest code and pinned dependency versions from the channels/providers branches. Work inside $WORKTREE_DIR. Do NOT push, restart, or deploy. Do not run the gate stack."

  # -------------------------------------------------------------------------
  # Phase 3 — Local-only deps, full-auto including majors
  # -------------------------------------------------------------------------
  log "Phase 3: local dependency updates (full-auto)"
  # Host: pnpm --latest still honors the 3-day minimumReleaseAge gate.
  ( cd "$WORKTREE_DIR" && pnpm update --latest ) 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log" || log "WARN: pnpm update failed"
  # agent-runner (bun) and google-mcp (npm): no release-age gate — gates catch breakage.
  ( cd "$WORKTREE_DIR/container/agent-runner" && bun update --latest ) 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log" || log "WARN: bun update failed"
  ( cd "$WORKTREE_DIR/container/nanoclaw-google-mcp" && npx --yes npm-check-updates -u && npm install ) 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log" || log "WARN: google-mcp update failed"
  # Keep the vestigial npm lockfiles from reappearing in the pnpm/bun trees.
  rm -f "$WORKTREE_DIR/package-lock.json" "$WORKTREE_DIR/container/agent-runner/package-lock.json"
fi

# ---------------------------------------------------------------------------
# Phase 4 — Gate stack (deterministic; the safety net)
# ---------------------------------------------------------------------------
# Only rebuild the container image when something baked INTO it changed
# (Dockerfile, build script, agent-runner deps, google-mcp). agent-runner/src
# and skills are mounted at runtime, not baked, so they don't need a rebuild —
# the e2e smoke exercises them against the live image. Skipping the rebuild on
# host-only nights avoids touching docker.io entirely (and its flaky proxy).
REBUILD_IMAGE=false
if ! git -C "$WORKTREE_DIR" diff --quiet HEAD -- \
     container/Dockerfile container/build.sh \
     container/agent-runner/package.json container/agent-runner/bun.lock \
     container/nanoclaw-google-mcp 2>/dev/null; then
  REBUILD_IMAGE=true
fi
log "Phase 4: gate stack (rebuild_image=$REBUILD_IMAGE)"
if ! run_gates "$WORKTREE_DIR" "$CANDIDATE_TAG" "$REBUILD_IMAGE"; then
  log "Pipeline halted: gate '$GATE_FAILED' failed — nothing deployed."
  notify_ren "$(printf '⚠️ *Nightly update halted*\n\nGate _%s_ failed — the update was discarded and *not deployed*. Ren is unchanged and still running on the previous version.\n\nCheck logs/nightly.log.' "$GATE_FAILED")"
  exit 1
fi

# ---------------------------------------------------------------------------
# Phase 5 — Decide & deploy
# ---------------------------------------------------------------------------
cd "$WORKTREE_DIR"
git add -A
if git diff --cached --quiet; then
  log "No changes after update — nothing to deploy."
  notify_ren "*Nightly update* — everything already current, no changes."
  exit 0
fi

SUMMARY=$(git -C "$WORKTREE_DIR" diff --cached --stat | tail -25)

if [ "$DRY_RUN" = true ] || [ "$GATES_ONLY" = true ]; then
  log "DRY RUN — gates passed, changes present, NOT deploying. Diff:"
  echo "$SUMMARY" | tee -a "$PROJECT_ROOT/logs/nightly.log"
  exit 0
fi

log "Phase 5: deploy"
git commit -q -m "chore: automated nightly update $(date +%Y-%m-%d)"
git push origin "$WORKTREE_BRANCH:main" 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log" || {
  log "ERROR: push failed — not deploying."
  notify_ren "⚠️ *Nightly update* — gates passed but push to origin failed. Not deployed."
  exit 1
}

# Bring the live tree to the pushed commit, rebuild the host, promote the image.
git -C "$PROJECT_ROOT" pull --ff-only origin main 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log"
( cd "$PROJECT_ROOT" && pnpm install --frozen-lockfile && pnpm run build ) 2>&1 | tee -a "$PROJECT_ROOT/logs/nightly.log"
# Only promote a candidate image if one was built; otherwise :latest is already
# correct (the container tree was unchanged this run).
if [ "$REBUILD_IMAGE" = "true" ]; then
  promote_image "$CANDIDATE_TAG"
else
  log "Container tree unchanged — keeping current :latest image."
fi

# Restart Ren; restart_and_verify rolls back the host commit if it won't boot.
if restart_and_verify "automated nightly update $(date +%Y-%m-%d)"; then
  log "Phase 6: deployed and verified."
  notify_ren "$(printf '✅ *Nightly update deployed*\n\nGates green, image promoted, Ren restarted and verified.\n\n```\n%s\n```' "$SUMMARY")"
else
  log "Deploy verification failed — restart_and_verify handled rollback/notify."
fi
