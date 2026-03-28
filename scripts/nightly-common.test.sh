#!/bin/bash
# Tests for scripts/nightly-common.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_PASSED=0
TESTS_FAILED=0

pass() { echo "  PASS: $1"; TESTS_PASSED=$((TESTS_PASSED + 1)); }
fail() { echo "  FAIL: $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); }

# Create isolated temp directory
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Set up a bare git repo + working clone for isolation
git init --bare "$TEST_DIR/origin.git" -b main >/dev/null 2>&1
git clone "$TEST_DIR/origin.git" "$TEST_DIR/project" >/dev/null 2>&1
(cd "$TEST_DIR/project" && git commit --allow-empty -m "init" && git push origin main) >/dev/null 2>&1

# Source nightly-common.sh with test variables
PROJECT_ROOT="$TEST_DIR/project"
LOG_PREFIX="[test]"
JOB_NAME="test-job"
source "$SCRIPT_DIR/nightly-common.sh"

# --- Test 1: log() outputs with prefix and timestamp ---
echo "Test 1: log() outputs with prefix and timestamp"
output=$(log "hello world")
if echo "$output" | grep -q '\[test\]' && echo "$output" | grep -q 'hello world' && echo "$output" | grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}'; then
  pass "log() output contains prefix, message, and timestamp"
else
  fail "log() output: $output"
fi

# --- Test 2: resolve_main_chat_jid() returns empty when no database exists ---
echo "Test 2: resolve_main_chat_jid() with no database"
# The function logs a WARN to stdout via log(), then echoes "".
# Capture only the last line (the return value); log lines go to stdout too.
result=$(resolve_main_chat_jid 2>/dev/null | tail -1)
if [ -z "$result" ]; then
  pass "resolve_main_chat_jid() returns empty when no DB"
else
  fail "resolve_main_chat_jid() returned '$result' instead of empty"
fi

# --- Test 3: resolve_main_chat_jid() reads from real SQLite database ---
echo "Test 3: resolve_main_chat_jid() with SQLite database"
db_dir="$PROJECT_ROOT/store"
mkdir -p "$db_dir"
/usr/bin/sqlite3 "$db_dir/messages.db" "CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, added_at TEXT, container_config TEXT, requires_trigger INTEGER, is_main INTEGER)"
/usr/bin/sqlite3 "$db_dir/messages.db" "INSERT INTO registered_groups (jid, is_main) VALUES ('tg:999', 1)"
result=$(resolve_main_chat_jid)
if [ "$result" = "tg:999" ]; then
  pass "resolve_main_chat_jid() returns 'tg:999'"
else
  fail "resolve_main_chat_jid() returned '$result' instead of 'tg:999'"
fi

# --- Test 4: notify_ren() skips when MAIN_CHAT_JID is empty ---
echo "Test 4: notify_ren() skips when MAIN_CHAT_JID is empty"
MAIN_CHAT_JID=""
ipc_dir="$PROJECT_ROOT/data/ipc/telegram_main/messages"
rm -rf "$PROJECT_ROOT/data/ipc" 2>/dev/null || true
notify_ren "test message" 2>/dev/null
if [ ! -d "$ipc_dir" ] || [ -z "$(ls -A "$ipc_dir" 2>/dev/null)" ]; then
  pass "notify_ren() skipped when MAIN_CHAT_JID is empty"
else
  fail "notify_ren() created files when MAIN_CHAT_JID was empty"
fi

# --- Test 5: notify_ren() writes valid JSON ---
echo "Test 5: notify_ren() writes valid JSON"
MAIN_CHAT_JID="tg:12345"
rm -rf "$PROJECT_ROOT/data/ipc" 2>/dev/null || true
notify_ren "Hello from test"
json_file=$(ls "$PROJECT_ROOT/data/ipc/telegram_main/messages/"*.json 2>/dev/null | head -1)
if [ -z "$json_file" ]; then
  fail "notify_ren() did not create a JSON file"
else
  valid=$(node -e "
    const data = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    if (data.type === 'message' && data.chatJid === 'tg:12345' && data.text === 'Hello from test') {
      process.stdout.write('ok');
    } else {
      process.stdout.write('bad: ' + JSON.stringify(data));
    }
  " "$json_file")
  if [ "$valid" = "ok" ]; then
    pass "notify_ren() wrote valid JSON with correct fields"
  else
    fail "notify_ren() JSON validation: $valid"
  fi
fi

# --- Test 6: notify_ren() handles special characters ---
echo "Test 6: notify_ren() handles special characters"
MAIN_CHAT_JID="tg:12345"
rm -rf "$PROJECT_ROOT/data/ipc" 2>/dev/null || true
notify_ren '*Bold* and "quotes" and
newlines'
json_file=$(ls "$PROJECT_ROOT/data/ipc/telegram_main/messages/"*.json 2>/dev/null | head -1)
if [ -z "$json_file" ]; then
  fail "notify_ren() did not create a JSON file for special characters"
else
  valid=$(node -e "
    const data = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const expected = '*Bold* and \"quotes\" and\nnewlines';
    if (data.text === expected) {
      process.stdout.write('ok');
    } else {
      process.stdout.write('bad: text=' + JSON.stringify(data.text) + ' expected=' + JSON.stringify(expected));
    }
  " "$json_file")
  if [ "$valid" = "ok" ]; then
    pass "notify_ren() preserved special characters (newlines, quotes, asterisks)"
  else
    fail "notify_ren() special characters: $valid"
  fi
fi

# --- Test 7: setup_worktree() creates a valid worktree ---
echo "Test 7: setup_worktree() creates a valid worktree"
setup_worktree >/dev/null 2>&1
if [ -d "$WORKTREE_DIR" ]; then
  if git -C "$WORKTREE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    current_branch=$(git -C "$WORKTREE_DIR" branch --show-current)
    if [ "$current_branch" = "$WORKTREE_BRANCH" ]; then
      pass "setup_worktree() created valid worktree on branch $WORKTREE_BRANCH"
    else
      fail "setup_worktree() branch is '$current_branch' instead of '$WORKTREE_BRANCH'"
    fi
  else
    fail "setup_worktree() directory is not a git repo"
  fi
else
  fail "setup_worktree() did not create WORKTREE_DIR"
fi

# --- Test 8: cleanup_worktree() removes worktree and branch ---
echo "Test 8: cleanup_worktree() removes worktree and branch"
saved_branch="$WORKTREE_BRANCH"
cleanup_worktree >/dev/null 2>&1
if [ -d "$WORKTREE_DIR" ]; then
  fail "cleanup_worktree() did not remove WORKTREE_DIR"
else
  branch_exists=$(git -C "$PROJECT_ROOT" branch --list "$saved_branch")
  if [ -z "$branch_exists" ]; then
    pass "cleanup_worktree() removed worktree and branch"
  else
    fail "cleanup_worktree() did not delete branch $saved_branch"
  fi
fi

# --- Test 9: setup_worktree() handles stale branch from previous run ---
echo "Test 9: setup_worktree() handles stale branch"
git -C "$PROJECT_ROOT" branch "test-job-$(date +%Y%m%d)" 2>/dev/null || true
setup_worktree >/dev/null 2>&1
if [ -d "$WORKTREE_DIR" ]; then
  pass "setup_worktree() succeeded despite stale branch"
else
  fail "setup_worktree() failed with stale branch"
fi
cleanup_worktree >/dev/null 2>&1

# --- Test 10: push_and_pull() pushes worktree commits to main ---
echo "Test 10: push_and_pull() pushes worktree commits to main"
setup_worktree >/dev/null 2>&1
(cd "$WORKTREE_DIR" && echo "change" > newfile.txt && git add . && git commit -m "test change") >/dev/null 2>&1
push_and_pull >/dev/null 2>&1
cleanup_worktree >/dev/null 2>&1
if [ -f "$PROJECT_ROOT/newfile.txt" ]; then
  pass "push_and_pull() pushed commit to main and pulled into PROJECT_ROOT"
else
  fail "push_and_pull() did not propagate newfile.txt to PROJECT_ROOT"
fi

echo ""
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
[ "$TESTS_FAILED" -eq 0 ] || exit 1
