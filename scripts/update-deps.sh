#!/bin/bash
# Update all NanoClaw dependencies across the three package trees.
#
# Usage:
#   ./scripts/update-deps.sh          # minor/patch only (safe)
#   ./scripts/update-deps.sh --major  # include major version bumps (review changelog first)
#
# After running, rebuild:
#   npm run build
#   CONTAINER_RUNTIME=docker ./container/build.sh
#   launchctl kickstart -k gui/$(id -u)/com.nanoclaw

set -e
cd "$(dirname "$0")/.."

MAJOR=false
if [ "$1" = "--major" ]; then
  MAJOR=true
fi

update_tree() {
  local dir="$1"
  local name="$2"
  echo ""
  echo "=== $name ==="
  cd "$dir"

  echo "Checking for outdated packages..."
  npm outdated 2>/dev/null || true

  if [ "$MAJOR" = true ]; then
    echo "Updating all packages (including major)..."
    npx npm-check-updates -u
    npm install
  else
    echo "Updating minor/patch versions..."
    npm update
  fi

  cd - > /dev/null
}

update_tree "." "Host (nanoclaw)"
update_tree "container/agent-runner" "Container agent-runner"
update_tree "container/nanoclaw-google-mcp" "Container Google MCP"

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. npm run build                              # rebuild host"
echo "  2. npm test                                   # run host tests"
echo "  3. CONTAINER_RUNTIME=docker ./container/build.sh  # rebuild container"
echo "  4. launchctl kickstart -k gui/\$(id -u)/com.nanoclaw  # restart"
