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

# Work in an isolated git worktree so the main working directory is never
# touched — this means the script succeeds even if the main tree is dirty.
WORKTREE_DIR="$PROJECT_ROOT/.worktrees/upstream-sync-$(date +%Y%m%d-%H%M%S)"
WORKTREE_BRANCH="upstream-sync-$(date +%Y%m%d)"
mkdir -p "$(dirname "$WORKTREE_DIR")"

cleanup_worktree() {
  if [ -d "$WORKTREE_DIR" ]; then
    log "Cleaning up worktree..."
    git -C "$PROJECT_ROOT" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
    git -C "$PROJECT_ROOT" branch -D "$WORKTREE_BRANCH" 2>/dev/null || true
  fi
}
trap cleanup_worktree EXIT

log "Creating worktree at $WORKTREE_DIR..."
git worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_DIR" main 2>&1

PROMPT="Sync NanoClaw with upstream changes. There are $NEW_COMMITS new commit(s) from upstream.

You are working in a git worktree at: $WORKTREE_DIR
The main repo is at: $PROJECT_ROOT
All git and build commands must run inside the worktree directory.

Context:
- upstream remote: qwibitai/nanoclaw-docker-sandbox (the open-source base)
- origin remote: IvanMerrill/nanoclaw (Ivan's customised fork)
- This fork has significant local customisations (Google MCP, Telegram, custom channels, security hardening)
- Conflicts are expected, especially in files we've heavily modified

Steps:
1. cd into the worktree: \`cd $WORKTREE_DIR\`

2. Review what's coming in:
   \`git log --oneline HEAD..upstream/main\`
   \`git diff HEAD...upstream/main --stat\`

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
   - \`npm install && npm run build\` from worktree root
   - \`npm test\` from worktree root
   - \`cd container/nanoclaw-google-mcp && npm install && npm run build && npm test\`
   - If tests fail, investigate and fix. Commit fixes separately.

6. If everything passes:
   - Push the branch: \`git push origin $WORKTREE_BRANCH\`
   - Fast-forward main: \`git push origin $WORKTREE_BRANCH:main\`
   - Rebuild container from the main repo:
     \`cd $PROJECT_ROOT && git pull && CONTAINER_RUNTIME=docker ./container/build.sh\`
   - Restart NanoClaw: \`launchctl kickstart -k gui/\$(id -u)/com.nanoclaw\`
   - Verify startup: check last 10 lines of $PROJECT_ROOT/logs/nanoclaw-launchd.log for errors

7. If the merge is too complex or risky:
   - Abort: \`git merge --abort\`
   - Report what went wrong so Ivan can handle it manually
   - The worktree will be cleaned up automatically

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
