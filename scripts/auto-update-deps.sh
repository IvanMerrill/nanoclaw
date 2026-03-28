#!/bin/bash
# Nightly dependency update: minor/patch daily, major on Sundays.
# Runs via launchd at 04:30 daily.
#
# Usage:
#   ./scripts/auto-update-deps.sh            # auto-detect mode from day-of-week
#   ./scripts/auto-update-deps.sh --major    # force major mode
#   ./scripts/auto-update-deps.sh --dry-run  # just report outdated packages

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_PREFIX="[update-deps]"
JOB_NAME="update-deps"

source "$PROJECT_ROOT/scripts/nightly-common.sh"

MAIN_CHAT_JID=$(resolve_main_chat_jid)

DRY_RUN=false
FORCE_MAJOR=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --major) FORCE_MAJOR=true ;;
  esac
done

# Determine mode: major on Sundays (day 7), minor otherwise
DAY_OF_WEEK=$(date +%u)
if [ "$FORCE_MAJOR" = true ] || [ "$DAY_OF_WEEK" = "7" ]; then
  MODE="major"
else
  MODE="minor"
fi

log "Mode: $MODE (day $DAY_OF_WEEK)"

if [ "$DRY_RUN" = true ]; then
  log "Dry run — checking for updates..."
  echo "=== Host ===" && (cd "$PROJECT_ROOT" && npm outdated 2>/dev/null) || true
  echo "=== agent-runner ===" && (cd "$PROJECT_ROOT/container/agent-runner" && npm outdated 2>/dev/null) || true
  echo "=== google-mcp ===" && (cd "$PROJECT_ROOT/container/nanoclaw-google-mcp" && npm outdated 2>/dev/null) || true
  exit 0
fi

# Set up worktree
setup_worktree
trap cleanup_worktree EXIT

if [ "$MODE" = "minor" ]; then
  PROMPT=$(cat <<ENDPROMPT
You are performing an automated nightly dependency update for NanoClaw (minor/patch only).

WORKING DIRECTORY: $WORKTREE_DIR
MAIN REPO: $PROJECT_ROOT
All git and build commands must run inside $WORKTREE_DIR unless stated otherwise.

There are three package trees:
- Host: worktree root
- Container agent-runner: container/agent-runner
- Container Google MCP: container/nanoclaw-google-mcp

STEP 1 — UPDATE

cd $WORKTREE_DIR
Run \`npm update\` in each of the three directories:
  npm update
  cd container/agent-runner && npm update && cd ../..
  cd container/nanoclaw-google-mcp && npm update && cd ../..

STEP 2 — CHECK FOR CHANGES

Run \`git diff --stat\` to see if anything changed.
If nothing changed, write an IPC notification and stop:
  node -e "
    const fs = require('fs');
    const path = require('path');
    const msg = { type: 'message', chatJid: process.argv[1], text: process.argv[2] };
    const dir = process.argv[3];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nightly-deps-' + Date.now() + '.json'), JSON.stringify(msg));
  " "$MAIN_CHAT_JID" "*Nightly dependency update* — all packages up to date." "$PROJECT_ROOT/data/ipc/telegram_main/messages"

STEP 3 — IDENTIFY CHANGES

Capture what changed: run \`npm outdated\` or \`git diff package-lock.json\` to identify updated packages and versions.

STEP 4 — BUILD AND TEST

Build:
  npm run build
  cd container/nanoclaw-google-mcp && npm run build

Test:
  cd $WORKTREE_DIR
  npm test
  cd container/nanoclaw-google-mcp && npm test

If build or test fails:
  - Investigate and try to fix (max 2 attempts)
  - If unfixable: \`git checkout -- .\` and write IPC notification about the failure, then stop

STEP 5 — COMMIT AND PUSH

git add -A && git commit -m "chore: automated dependency update $(date +%Y-%m-%d)"
git push origin $WORKTREE_BRANCH:main

STEP 6 — PULL AND REBUILD

cd $PROJECT_ROOT && git pull --ff-only origin main || true
CONTAINER_RUNTIME=docker $PROJECT_ROOT/container/build.sh

STEP 7 — NOTIFY

Write an IPC notification listing updated packages and build/test status:
  node -e "
    const fs = require('fs');
    const path = require('path');
    const msg = { type: 'message', chatJid: process.argv[1], text: process.argv[2] };
    const dir = process.argv[3];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nightly-deps-' + Date.now() + '.json'), JSON.stringify(msg));
  " "$MAIN_CHAT_JID" "<your formatted summary>" "$PROJECT_ROOT/data/ipc/telegram_main/messages"

Format the summary using Telegram formatting:
  *single asterisks* for bold, • for bullet points, _underscores_ for italic.
  Include: which packages were updated (name and version range), build/test status.

STEP 8 — RESTART AND VERIFY

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
  If now running, write IPC notification about rollback (same node -e approach)
  If still not running, log CRITICAL error

IMPORTANT:
- NEVER force push
- Do not make any code changes beyond what is needed to fix build/test failures from the updates
- Every step must be logged clearly
ENDPROMPT
)
else
  PROMPT=$(cat <<ENDPROMPT
You are performing an automated nightly dependency update for NanoClaw (major version bumps included).

WORKING DIRECTORY: $WORKTREE_DIR
MAIN REPO: $PROJECT_ROOT
All git and build commands must run inside $WORKTREE_DIR unless stated otherwise.

There are three package trees:
- Host: worktree root
- Container agent-runner: container/agent-runner
- Container Google MCP: container/nanoclaw-google-mcp

PHASE 1 — MINOR/PATCH UPDATES

cd $WORKTREE_DIR
Run \`npm update\` in each of the three directories:
  npm update
  cd container/agent-runner && npm update && cd ../..
  cd container/nanoclaw-google-mcp && npm update && cd ../..

If anything changed:
  npm run build
  cd container/nanoclaw-google-mcp && npm run build
  cd $WORKTREE_DIR && npm test
  cd container/nanoclaw-google-mcp && npm test
  If build/test fails: try to fix (max 2 attempts). If unfixable: \`git checkout -- .\` and write notification about the failure.
  If successful: git add -A && git commit -m "chore: automated minor dependency update $(date +%Y-%m-%d)"

PHASE 2 — MAJOR VERSION BUMPS

Run \`npm outdated\` in all three trees to find packages with major version bumps available.
If no major updates exist, proceed to Phase 3 with just the minor changes.

For each major update, one at a time:

  a. Search the web for the changelog or release notes of the package
  b. Classify the update:

     DECISION: <package> <current> → <latest>
     Verdict: APPLY|REVIEW|SKIP
     Reason: <explanation>

  c. Risk rules — classify as REVIEW if:
     - It is a core dependency (typescript, grammy, @anthropic-ai/sdk, vitest, better-sqlite3, sharp)
     - The changelog mentions removed or renamed APIs that we use
     - It requires more than 20 lines of code modification

  d. For APPLY (safe, <20 lines of code changes needed):
     - Install: \`npm install <pkg>@latest\` in the correct directory
     - Build the relevant tree
     - Test the relevant tree
     - If build/test fails, try to fix (max 2 attempts). If unfixable, revert with \`git checkout -- .\` and reclassify as SKIP
     - Commit individually: \`git add -A && git commit -m "chore: update <pkg> <old> → <new>"\`

  e. For REVIEW: note for the notification summary — Ivan will handle these manually

  f. For SKIP: log the reason

PHASE 3 — PUSH AND REBUILD

git push origin $WORKTREE_BRANCH:main
cd $PROJECT_ROOT && git pull --ff-only origin main || true
CONTAINER_RUNTIME=docker $PROJECT_ROOT/container/build.sh

PHASE 4 — NOTIFY

Write an IPC notification:
  node -e "
    const fs = require('fs');
    const path = require('path');
    const msg = { type: 'message', chatJid: process.argv[1], text: process.argv[2] };
    const dir = process.argv[3];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nightly-deps-' + Date.now() + '.json'), JSON.stringify(msg));
  " "$MAIN_CHAT_JID" "<your formatted summary>" "$PROJECT_ROOT/data/ipc/telegram_main/messages"

Format the summary using Telegram formatting:
  *single asterisks* for bold, • for bullet points, _underscores_ for italic.
  Include:
  - Minor/patch updates applied (package list)
  - Major updates applied (with APPLY decisions)
  - Major updates needing review (with REVIEW decisions and reasons)
  - Major updates skipped (with SKIP reasons)
  - Build/test status

PHASE 5 — RESTART AND VERIFY

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
  If now running, write IPC notification about rollback (same node -e approach)
  If still not running, log CRITICAL error

IMPORTANT:
- NEVER force push
- Be conservative — skip updates that need major refactoring
- Each major update commit should be atomic and revertable
- Every decision must be logged with reasoning
- If you cannot complete the task, explain why clearly in the log output
ENDPROMPT
)
fi

log "Starting $MODE dependency update via Claude Code..."
claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch" \
  2>&1 | tee -a "$PROJECT_ROOT/logs/update-deps.log"

log "Claude Code session complete."
