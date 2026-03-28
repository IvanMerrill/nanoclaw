#!/bin/bash
# Tests for scripts/auto-upstream-sync.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_PASSED=0
TESTS_FAILED=0

pass() { echo "  PASS: $1"; TESTS_PASSED=$((TESTS_PASSED + 1)); }
fail() { echo "  FAIL: $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); }

# Create isolated temp directory
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# --- Setup: bare origin, working clone, bare upstream ---
git init --bare "$TEST_DIR/origin.git" -b main >/dev/null 2>&1
git clone "$TEST_DIR/origin.git" "$TEST_DIR/project" >/dev/null 2>&1
(cd "$TEST_DIR/project" && git commit --allow-empty -m "init" && git push origin main) >/dev/null 2>&1

# Create bare upstream repo with the same initial commit
git init --bare "$TEST_DIR/upstream.git" -b main >/dev/null 2>&1
# Push the initial commit to upstream so they share history
(cd "$TEST_DIR/project" && git remote add upstream "$TEST_DIR/upstream.git" && git push upstream main) >/dev/null 2>&1

PROJECT_ROOT="$TEST_DIR/project"

# Create store/messages.db so resolve_main_chat_jid doesn't warn
mkdir -p "$PROJECT_ROOT/store"
/usr/bin/sqlite3 "$PROJECT_ROOT/store/messages.db" "CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, added_at TEXT, container_config TEXT, requires_trigger INTEGER, is_main INTEGER)"
/usr/bin/sqlite3 "$PROJECT_ROOT/store/messages.db" "INSERT INTO registered_groups (jid, is_main) VALUES ('tg:test-chat', 1)"

# Create data and IPC directories
mkdir -p "$PROJECT_ROOT/data/ipc/telegram_main/messages"
mkdir -p "$PROJECT_ROOT/logs"

# Symlink scripts/ into the test project so the script computes PROJECT_ROOT correctly
ln -s "$SCRIPT_DIR" "$PROJECT_ROOT/scripts"

# Helper: add a commit to the upstream bare repo via a temporary clone
add_upstream_commit() {
  local msg="$1"
  local tmp="$TEST_DIR/upstream-work"
  if [ ! -d "$tmp" ]; then
    git clone "$TEST_DIR/upstream.git" "$tmp" >/dev/null 2>&1
  fi
  (cd "$tmp" && git pull >/dev/null 2>&1 && git commit --allow-empty -m "$msg" && git push origin main) >/dev/null 2>&1
}

# Helper: run the sync script with given args, capture output
run_sync() {
  bash "$PROJECT_ROOT/scripts/auto-upstream-sync.sh" "$@" 2>&1 || true
}

echo "=== auto-upstream-sync.sh tests ==="
echo ""

# --- Test 1: Sync marker fallback to merge-base when no marker file exists ---
echo "Test 1: Sync marker fallback to merge-base (no marker file)"
rm -f "$PROJECT_ROOT/data/upstream-last-synced"
output=$(run_sync --dry-run)
if echo "$output" | grep -q "No new upstream commits"; then
  pass "No marker file => merge-base => no new commits reported"
else
  fail "Expected 'No new upstream commits', got: $output"
fi

# --- Test 2: Sync marker reads from file ---
echo "Test 2: Sync marker reads from file"
# Record current upstream HEAD as the "old" marker
old_hash=$(git -C "$PROJECT_ROOT" rev-parse upstream/main)
mkdir -p "$PROJECT_ROOT/data"
echo "$old_hash" > "$PROJECT_ROOT/data/upstream-last-synced"
# Add one new commit to upstream
add_upstream_commit "upstream: new feature X"
output=$(run_sync --dry-run)
if echo "$output" | grep -q "1 new upstream commit"; then
  pass "Marker file used — reported exactly 1 new commit"
else
  fail "Expected '1 new upstream commit', got: $output"
fi

# --- Test 3: Sync marker fallback when marker contains invalid hash ---
echo "Test 3: Sync marker fallback on invalid hash"
echo "deadbeef1234567890abcdef1234567890abcdef" > "$PROJECT_ROOT/data/upstream-last-synced"
output=$(run_sync --dry-run)
if echo "$output" | grep -q "no longer exists, falling back" || echo "$output" | grep -q "new upstream commit" || echo "$output" | grep -q "No new upstream commits"; then
  pass "Invalid hash in marker => script did not crash, fell back gracefully"
else
  fail "Expected graceful fallback, got: $output"
fi

# --- Test 4: --dry-run flag exits without creating worktree ---
echo "Test 4: --dry-run exits without creating worktree"
# Ensure there are new commits so we get past the "no new commits" early exit
current_hash=$(git -C "$PROJECT_ROOT" rev-parse upstream/main)
echo "$old_hash" > "$PROJECT_ROOT/data/upstream-last-synced"
# We already added 1 commit in test 2, so there should be 1 new commit
output=$(run_sync --dry-run)
if echo "$output" | grep -q "Dry run"; then
  pass "--dry-run logged 'Dry run' message"
else
  fail "Expected 'Dry run' in output, got: $output"
fi
# Verify no worktree was created
worktree_entries=$(find "$PROJECT_ROOT/.worktrees" -mindepth 1 -maxdepth 1 2>/dev/null || true)
if [ -z "$worktree_entries" ]; then
  pass "--dry-run did not create any worktree"
else
  fail "--dry-run created worktree(s): $worktree_entries"
fi

# --- Test 5: No upstream changes produces notification ---
echo "Test 5: No upstream changes => notification written"
# Set marker to current upstream HEAD so there are zero new commits
latest_hash=$(git -C "$PROJECT_ROOT" fetch upstream >/dev/null 2>&1 && git -C "$PROJECT_ROOT" rev-parse upstream/main)
echo "$latest_hash" > "$PROJECT_ROOT/data/upstream-last-synced"
# Clear IPC directory
rm -f "$PROJECT_ROOT/data/ipc/telegram_main/messages/"*.json
output=$(run_sync)
if echo "$output" | grep -q "No new upstream commits"; then
  pass "Reported no new upstream commits"
else
  fail "Expected 'No new upstream commits', got: $output"
fi
# Check that an IPC notification file was written
ipc_files=$(ls "$PROJECT_ROOT/data/ipc/telegram_main/messages/"*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$ipc_files" -ge 1 ]; then
  pass "IPC notification file written on no-change path"
else
  fail "No IPC notification file found"
fi

# --- Test 6: Commit count is correct ---
echo "Test 6: Commit count is correct with 3 new commits"
# Record current upstream HEAD as the marker
latest_hash=$(git -C "$PROJECT_ROOT" rev-parse upstream/main)
echo "$latest_hash" > "$PROJECT_ROOT/data/upstream-last-synced"
# Add 3 new commits to upstream
add_upstream_commit "upstream: improvement A"
add_upstream_commit "upstream: improvement B"
add_upstream_commit "upstream: improvement C"
output=$(run_sync --dry-run)
if echo "$output" | grep -q "3 new upstream commit"; then
  pass "Correctly reported 3 new upstream commits"
else
  fail "Expected '3 new upstream commit(s)', got: $output"
fi

echo ""
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
[ "$TESTS_FAILED" -eq 0 ] || exit 1
