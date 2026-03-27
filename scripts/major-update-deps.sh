#!/bin/bash
# Check for major dependency updates and launch Claude Code to handle them.
#
# Usage:
#   ./scripts/major-update-deps.sh           # check and apply
#   ./scripts/major-update-deps.sh --dry-run  # just report what's available
#
# Runs headless Claude Code to:
#   1. Review changelogs for breaking changes
#   2. Apply updates one at a time
#   3. Fix any build/test failures
#   4. Commit each update separately
#   5. Rebuild container and restart

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

LOG_PREFIX="[major-update]"
log() { echo "$LOG_PREFIX $(date '+%Y-%m-%d %H:%M:%S') $*"; }

# Ensure clean working tree
if [ -n "$(git status --porcelain)" ]; then
  log "ERROR: Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Collect outdated major versions across all trees
log "Checking for major version updates..."

MAJORS=""

collect_majors() {
  local dir="$1"
  local label="$2"
  local outdated
  outdated=$(cd "$dir" && npm outdated --json 2>/dev/null || echo "{}")

  # Extract packages where current != latest and latest != wanted (major bump)
  local pkgs
  pkgs=$(echo "$outdated" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except:
    sys.exit(0)
for pkg, info in data.items():
    current = info.get('current', '')
    wanted = info.get('wanted', '')
    latest = info.get('latest', '')
    if latest and current and latest != current and latest != wanted:
        print(f'{label}|{pkg}|{current}|{latest}')
" 2>/dev/null || true)

  if [ -n "$pkgs" ]; then
    MAJORS="${MAJORS}${pkgs}"$'\n'
  fi
}

collect_majors "." "host"
collect_majors "container/agent-runner" "agent-runner"
collect_majors "container/nanoclaw-google-mcp" "google-mcp"

# Trim trailing newlines
MAJORS=$(echo "$MAJORS" | sed '/^$/d')

if [ -z "$MAJORS" ]; then
  log "No major updates available."
  exit 0
fi

log "Major updates available:"
echo "$MAJORS" | while IFS='|' read -r tree pkg current latest; do
  echo "  $tree: $pkg $current → $latest"
done

if [ "$DRY_RUN" = true ]; then
  log "Dry run — not applying changes."
  exit 0
fi

# Build the prompt for Claude Code
PROMPT="You are updating NanoClaw dependencies. The following major version updates are available:

$(echo "$MAJORS" | while IFS='|' read -r tree pkg current latest; do
  echo "- $tree: $pkg $current → $latest"
done)

For each package, in order:
1. Check the changelog/release notes (use WebSearch or WebFetch on the package's GitHub releases or npm page) for breaking changes relevant to our usage
2. Update the package: run \`npm install <pkg>@latest\` in the correct directory (host = project root, agent-runner = container/agent-runner, google-mcp = container/nanoclaw-google-mcp)
3. Build: \`npm run build\` in the relevant directory
4. If the build fails, fix the code to accommodate the breaking changes
5. Test: \`npm test\` in the relevant directory
6. If tests fail, fix the code
7. Commit the single package update with a message like: \`chore: update <pkg> <old> → <new>\` and note any code changes needed for compatibility
8. Move to the next package

After all packages are updated:
- Rebuild the container: \`CONTAINER_RUNTIME=docker ./container/build.sh\`
- Restart NanoClaw: \`launchctl kickstart -k gui/\$(id -u)/com.nanoclaw\`

Important:
- Update one package at a time so each commit is atomic and revertable
- If a package update is too risky or requires extensive changes, skip it and note why
- Do not modify any functionality beyond what's needed for compatibility
- Run the full test suite after all updates: \`npm test\` from the project root"

log "Launching Claude Code to handle updates..."
claude -p "$PROMPT" --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch" 2>&1 | tee -a "$PROJECT_ROOT/logs/major-update-deps.log"

log "Claude Code session complete."
