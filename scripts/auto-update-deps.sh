#!/bin/bash
# Automated dependency update for NanoClaw via headless Claude Code.
#
# Usage:
#   ./scripts/auto-update-deps.sh          # minor/patch only (daily)
#   ./scripts/auto-update-deps.sh --major  # include major bumps (weekly)
#   ./scripts/auto-update-deps.sh --dry-run # just report what's available
#
# Launches a headless Claude Code session that handles the full update
# lifecycle: check, update, build, test, fix, commit, rebuild, restart.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

MODE="minor"
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --major) MODE="major" ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

LOG_PREFIX="[auto-update-deps]"
log() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"; }

if [ "$DRY_RUN" = true ]; then
  log "Dry run — checking for updates..."
  echo "=== Host ===" && npm outdated 2>/dev/null || true
  echo "=== agent-runner ===" && (cd container/agent-runner && npm outdated 2>/dev/null) || true
  echo "=== google-mcp ===" && (cd container/nanoclaw-google-mcp && npm outdated 2>/dev/null) || true
  exit 0
fi

# Work in an isolated git worktree so the main working directory is never
# touched — this means the script succeeds even if the main tree is dirty.
WORKTREE_DIR="$PROJECT_ROOT/.worktrees/update-deps-$(date +%Y%m%d-%H%M%S)"
WORKTREE_BRANCH="update-deps-$(date +%Y%m%d)"
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

if [ "$MODE" = "minor" ]; then
  PROMPT="Update NanoClaw dependencies (minor/patch only — stay within semver ranges).

You are working in a git worktree at: $WORKTREE_DIR
The main repo is at: $PROJECT_ROOT
All commands must run inside the worktree directory.

There are three package trees:
- Host: worktree root (npm update)
- Container agent-runner: container/agent-runner (npm update)
- Container Google MCP: container/nanoclaw-google-mcp (npm update)

Steps:
1. cd into the worktree: \`cd $WORKTREE_DIR\`
2. Run \`npm update\` in each of the three directories
3. Check if anything changed with \`git status\`. If nothing changed, say 'No updates available' and stop.
4. Build host: \`npm run build\` from worktree root
5. Build google-mcp: \`cd container/nanoclaw-google-mcp && npm run build\`
6. Test host: \`npm test\` from worktree root
7. Test google-mcp: \`cd container/nanoclaw-google-mcp && npm test\`
8. If any build or test fails, investigate and fix. If unfixable, roll back with \`git checkout -- .\` and report what failed.
9. Commit all changes: \`git add -A && git commit -m 'chore: automated dependency update YYYY-MM-DD'\`
10. Push to main: \`git push origin $WORKTREE_BRANCH:main\`
11. Pull in main repo and rebuild container:
    \`cd $PROJECT_ROOT && git pull && CONTAINER_RUNTIME=docker ./container/build.sh\`
12. Restart NanoClaw: \`launchctl kickstart -k gui/\$(id -u)/com.nanoclaw\`
13. Verify startup by checking the last 10 lines of $PROJECT_ROOT/logs/nanoclaw-launchd.log for errors

Do not make any code changes beyond what's needed to fix build/test failures from the updates."
else
  PROMPT="Update NanoClaw dependencies including MAJOR version bumps.

You are working in a git worktree at: $WORKTREE_DIR
The main repo is at: $PROJECT_ROOT
All commands must run inside the worktree directory.

There are three package trees:
- Host: worktree root
- Container agent-runner: container/agent-runner
- Container Google MCP: container/nanoclaw-google-mcp

Steps:
1. cd into the worktree: \`cd $WORKTREE_DIR\`
2. Run \`npm outdated\` in each directory to see what major updates are available
3. If no major updates exist, say 'No major updates available' and stop.
4. For each major update, one at a time:
   a. Search the web for the package's changelog or release notes to understand breaking changes
   b. Install the update: \`npm install <pkg>@latest\` in the correct directory
   c. Build the relevant tree
   d. If the build fails, fix the code to accommodate breaking changes
   e. Test the relevant tree
   f. If tests fail, fix the code
   g. If the update is too risky or requires extensive rewriting, revert it with \`git checkout -- .\` and skip to the next package
   h. Commit this single update: \`git add -A && git commit -m 'chore: update <pkg> <old> → <new>'\` noting any code changes
5. After all updates, run the full test suite from worktree root: \`npm test\`
6. Push to main: \`git push origin $WORKTREE_BRANCH:main\`
7. Pull in main repo and rebuild container:
   \`cd $PROJECT_ROOT && git pull && CONTAINER_RUNTIME=docker ./container/build.sh\`
8. Restart NanoClaw: \`launchctl kickstart -k gui/\$(id -u)/com.nanoclaw\`
9. Verify startup by checking the last 10 lines of $PROJECT_ROOT/logs/nanoclaw-launchd.log for errors

Be conservative — skip updates that need major refactoring. Each commit should be atomic and revertable."
fi

log "Starting $MODE dependency update via Claude Code..."
claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch" \
  2>&1 | tee -a "$PROJECT_ROOT/logs/update-deps.log"

log "Claude Code session complete."
