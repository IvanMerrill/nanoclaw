#!/bin/bash
# Automated upstream sync for NanoClaw via headless Claude Code.
#
# Fetches upstream changes, merges them, resolves conflicts,
# builds, tests, and pushes — all through a Claude Code session.
#
# Usage:
#   ./scripts/auto-upstream-sync.sh            # sync from upstream
#   ./scripts/auto-upstream-sync.sh --dry-run   # just show what's new

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

LOG_PREFIX="[upstream-sync]"
log() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  log "ERROR: Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Fetch upstream
log "Fetching upstream..."
git fetch upstream 2>&1

# Check if there are new commits
NEW_COMMITS=$(git log --oneline HEAD..upstream/main 2>/dev/null | wc -l | tr -d ' ')

if [ "$NEW_COMMITS" = "0" ]; then
  log "No new upstream commits. Nothing to do."
  exit 0
fi

log "$NEW_COMMITS new upstream commit(s) available:"
git log --oneline HEAD..upstream/main 2>/dev/null | head -20

if [ "$DRY_RUN" = true ]; then
  log "Dry run — not applying changes."
  exit 0
fi

PROMPT="Sync NanoClaw with upstream changes. There are $NEW_COMMITS new commit(s) from upstream.

Context:
- upstream remote: qwibitai/nanoclaw-docker-sandbox (the open-source base)
- origin remote: IvanMerrill/nanoclaw (Ivan's customised fork)
- This fork has significant local customisations (Google MCP, Telegram, custom channels, security hardening)
- Conflicts are expected, especially in files we've heavily modified

Steps:
1. First, review what's coming in:
   \`git log --oneline HEAD..upstream/main\`
   \`git diff HEAD...upstream/main --stat\`

2. Create a sync branch:
   \`git checkout -b upstream-sync-\$(date +%Y%m%d)\`

3. Merge upstream:
   \`git merge upstream/main --no-edit\`

4. If there are merge conflicts:
   - List them with \`git diff --name-only --diff-filter=U\`
   - For each conflict, read the file and resolve intelligently:
     - package-lock.json: accept ours and regenerate with \`npm install\`
     - package.json version/badge: accept theirs for version, keep our dependencies
     - Files we've heavily customised (container-runner.ts, index.ts, ipc.ts, agent-runner): carefully merge, preserving our customisations (Google MCP, security hardening, token vendor, send_email restrictions)
     - New upstream files: accept as-is
     - CLAUDE.md: keep ours (has our custom content)
   - After resolving each file: \`git add <file>\`
   - When all resolved: \`git commit --no-edit\`

5. Build and test:
   - \`npm run build\` from project root
   - \`npm test\` from project root
   - \`cd container/nanoclaw-google-mcp && npm run build && npm test\`
   - If tests fail, investigate and fix. Commit fixes separately.

6. If everything passes:
   - Merge back to main: \`git checkout main && git merge upstream-sync-\$(date +%Y%m%d) --no-edit\`
   - Delete the sync branch: \`git branch -d upstream-sync-\$(date +%Y%m%d)\`
   - Rebuild container: \`CONTAINER_RUNTIME=docker ./container/build.sh\`
   - Restart NanoClaw: \`launchctl kickstart -k gui/\$(id -u)/com.nanoclaw\`
   - Verify startup: check last 10 lines of logs/nanoclaw-launchd.log for errors
   - Push to origin: \`git push origin main\`

7. If the merge is too complex or risky:
   - Abort: \`git merge --abort && git checkout main && git branch -D upstream-sync-\$(date +%Y%m%d)\`
   - Report what went wrong so Ivan can handle it manually

Important:
- NEVER force push
- NEVER delete or overwrite our local customisations
- Preserve all Google MCP, security, and channel changes
- When in doubt, keep ours and note the conflict for manual review"

log "Launching Claude Code to handle upstream sync..."
claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch" \
  2>&1 | tee -a "$PROJECT_ROOT/logs/upstream-sync.log"

log "Claude Code session complete."
