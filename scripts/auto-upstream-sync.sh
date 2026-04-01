#!/bin/bash
# Nightly upstream sync: run /update-nanoclaw via Claude Code.
# Runs via launchd at 03:30 daily.
#
# Usage:
#   ./scripts/auto-upstream-sync.sh            # full run
#   ./scripts/auto-upstream-sync.sh --dry-run  # just show what's new

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PREFIX="[upstream-sync]"
JOB_NAME="upstream-sync"

source "$PROJECT_ROOT/scripts/nightly-common.sh"

MAIN_CHAT_JID=$(resolve_main_chat_jid)

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

# Fetch upstream (qwibitai is the active upstream with all changes)
log "Fetching upstream..."
git -C "$PROJECT_ROOT" fetch qwibitai 2>&1

NEW_COMMITS=$(git -C "$PROJECT_ROOT" log --oneline HEAD..qwibitai/main 2>/dev/null | wc -l | tr -d ' ')

if [ "$NEW_COMMITS" = "0" ]; then
  log "No new upstream commits."
  notify_ren "*Nightly upstream sync* — no new upstream commits."
  exit 0
fi

log "$NEW_COMMITS new upstream commit(s):"
git -C "$PROJECT_ROOT" log --oneline HEAD..qwibitai/main 2>/dev/null | head -20 || true

if [ "$DRY_RUN" = true ]; then
  log "Dry run — not applying."
  exit 0
fi

IFS= read -r -d '' PROMPT <<'ENDPROMPT' || true
You are updating Ren, Ivan's AI helpful friend. You should run /update-nanoclaw and ensure you update everything without assistance. In each circumstance that a decision is required, look at the codebase, the features used, and ensure you only update based on providing new features, security updates, genuinely helpful changes, and don't update things that aren't related to the way you are currently used or your current architecture. E.g. we use telegram and not whatsapp so a breaking code change for improving whatsapp isn't required unless we're also vulnerable. After this has been run, you've rebuilt it and all tests have passed successfully, push everything to github, then restart Ren for the changes to take effect. IF they don't work and you see errors, roll back the changes and restart so Ren is brought back online. In both cases make sure Ren provides a full update of what has happened through telegram.
ENDPROMPT

log "Launching Claude Code to handle upstream sync..."
claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Skill" \
  2>&1 | tee -a "$PROJECT_ROOT/logs/upstream-sync.log"

log "Claude Code session complete."
