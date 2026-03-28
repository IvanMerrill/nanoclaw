#!/bin/bash
# Nightly upstream sync: review upstream commits and selectively cherry-pick.
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
SYNC_MARKER="$PROJECT_ROOT/data/upstream-last-synced"

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

# Fetch upstream
log "Fetching upstream..."
git -C "$PROJECT_ROOT" fetch upstream 2>&1

# Determine the range of commits to review.
# Use the sync marker if it exists (tracks last-reviewed upstream commit),
# otherwise fall back to merge-base between HEAD and upstream/main.
if [ -f "$SYNC_MARKER" ]; then
  LAST_SYNCED=$(cat "$SYNC_MARKER" | tr -d '[:space:]')
  # Verify the commit still exists in upstream
  if ! git -C "$PROJECT_ROOT" cat-file -e "$LAST_SYNCED" 2>/dev/null; then
    log "WARN: Sync marker commit $LAST_SYNCED no longer exists, falling back to merge-base"
    LAST_SYNCED=$(git -C "$PROJECT_ROOT" merge-base HEAD upstream/main 2>/dev/null)
  fi
else
  LAST_SYNCED=$(git -C "$PROJECT_ROOT" merge-base HEAD upstream/main 2>/dev/null)
fi

NEW_COMMITS=$(git -C "$PROJECT_ROOT" log --oneline "$LAST_SYNCED..upstream/main" 2>/dev/null | wc -l | tr -d ' ')

if [ "$NEW_COMMITS" = "0" ]; then
  log "No new upstream commits since $LAST_SYNCED."
  notify_ren "*Nightly upstream sync* — no new upstream commits."
  exit 0
fi

log "$NEW_COMMITS new upstream commit(s) since $(echo $LAST_SYNCED | cut -c1-7):"
git -C "$PROJECT_ROOT" log --oneline "$LAST_SYNCED..upstream/main" 2>/dev/null | head -20 || true

if [ "$DRY_RUN" = true ]; then
  log "Dry run — not applying."
  exit 0
fi

# Set up worktree
setup_worktree
trap cleanup_worktree EXIT

# Claude prompt — assigned via HEREDOC for readability
# Using read + heredoc (not $(cat <<...) which breaks on apostrophes inside $(...))
IFS= read -r -d '' PROMPT <<ENDPROMPT || true
You are performing an automated nightly upstream sync for NanoClaw.

WORKING DIRECTORY: $WORKTREE_DIR
MAIN REPO: $PROJECT_ROOT
All git and build commands must run inside $WORKTREE_DIR unless stated otherwise.

CONTEXT:
- upstream: qwibitai/nanoclaw-docker-sandbox (open-source base)
- origin: IvanMerrill/nanoclaw (Ivan's customised fork)
- This fork has SIGNIFICANT local customisations: Google MCP, Telegram channel, Gmail integration, security hardening, custom IPC extensions, file attachment support, agent swarm
- You are NOT doing a blind merge. You are reviewing each commit and deciding whether to apply it.
- Commits to review: from $LAST_SYNCED to upstream/main

STEP 1 — REVIEW COMMITS

cd $WORKTREE_DIR

List all commits to review:
  git log --oneline --reverse $LAST_SYNCED..upstream/main

For EACH commit, review the diff:
  git show <hash> --stat
  git show <hash>

Classify each as:
  APPLY  — relevant, safe to cherry-pick as-is (bug fix in shared code, new useful feature)
  ADAPT  — relevant but needs modification for our fork (touches customised file but change is valuable)
  SKIP   — not relevant (feature we don't use, or we've solved differently)
  REVIEW — too risky or complex, needs Ivan's review

Log EVERY decision:
  DECISION: <hash> <short message>
  Verdict: APPLY|ADAPT|SKIP|REVIEW
  Reason: <1-2 sentence explanation>

RISK RULES:
- If a commit modifies files from CLAUDE.md Key Files (src/index.ts, src/ipc.ts, src/container-runner.ts, src/router.ts, src/config.ts, src/db.ts) AND changes existing logic (not just adding a new export or fixing a clear bug), classify as REVIEW
- If a commit significantly refactors a file we've customised, classify as REVIEW
- If there are more than 5 new commits AND any is REVIEW, skip ALL commits and just report findings
- If a REVIEW commit conflicts with an APPLY/ADAPT commit, skip ALL and report
- When in doubt: REVIEW, not APPLY

STEP 2 — APPLY CHANGES

For each APPLY commit (chronological order):
  git cherry-pick <hash>
  If conflict:
    - package-lock.json: git checkout --ours package-lock.json && npm install && git add package-lock.json
    - package.json: keep our deps, accept their version bumps where they don't conflict with ours
    - CLAUDE.md / README.md: git checkout --ours <file> && git add <file>
    - Any other conflict: git cherry-pick --abort, reclassify as REVIEW

For each ADAPT commit:
  git cherry-pick <hash>
  Resolve conflicts as above, then make modifications needed for our fork.
  git commit --amend --no-edit

STEP 3 — BUILD AND TEST

npm install
npm run build
npm test
If any container files changed (container/ directory): cd container/nanoclaw-google-mcp && npm install && npm run build && npm test

If build/tests fail:
  - Read errors, try to fix (max 2 attempts)
  - If unfixable: git reset --hard main, report failure

STEP 4 — UPDATE SYNC MARKER

Write the latest upstream commit hash to the sync marker file so tomorrow's run starts from here:
  git rev-parse upstream/main > $PROJECT_ROOT/data/upstream-last-synced

Do this even if some commits were skipped or classified as REVIEW — the marker tracks what has been REVIEWED, not what was applied.

STEP 5 — PUSH AND NOTIFY

If changes were applied:
  git push origin $WORKTREE_BRANCH:main
  cd $PROJECT_ROOT && git pull --ff-only origin main || true
  CONTAINER_RUNTIME=docker $PROJECT_ROOT/container/build.sh

Write an IPC notification. Use this exact command:
  node -e "
    const fs = require('fs');
    const path = require('path');
    const msg = { type: 'message', chatJid: process.argv[1], text: process.argv[2] };
    const dir = process.argv[3];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nightly-upstream-' + Date.now() + '.json'), JSON.stringify(msg));
  " "\$MAIN_CHAT_JID" "<your formatted summary>" "$PROJECT_ROOT/data/ipc/telegram_main/messages"

Format the summary using Telegram formatting:
  *single asterisks* for bold, bullet points with •, _underscores_ for italic.
  Include: which commits were applied (hash + message), which were skipped (with reason), which need review, build/test status.

If NO changes were applied (all SKIP/REVIEW): still write the notification summarising the review.

STEP 6 — RESTART REN

launchctl kickstart -k "gui/\$(id -u)/com.nanoclaw"
sleep 8

Check Ren is running:
  pgrep -f "node.*dist/index.js"

If NOT running:
  cd $PROJECT_ROOT
  git revert HEAD --no-edit
  npm install && npm run build
  git push origin main
  launchctl kickstart -k "gui/\$(id -u)/com.nanoclaw"
  sleep 8
  If now running, write notification about rollback (same node -e approach)
  If still not running, log CRITICAL error

IMPORTANT:
- NEVER force push
- NEVER delete or overwrite our local customisations
- Every decision must be logged with reasoning
- If you cannot complete the task, explain why clearly in the log output
ENDPROMPT

log "Launching Claude Code to handle upstream sync..."
claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch" \
  2>&1 | tee -a "$PROJECT_ROOT/logs/upstream-sync.log"

log "Claude Code session complete."
