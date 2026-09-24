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

# The real repo root — notify_ren shells out to scripts/notify-main-chat.ts,
# which lives here. Data dirs are isolated per-test via NANOCLAW_ROOT.
REAL_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

# Build an isolated v2 data root with one active Telegram session and an empty
# outbound.db, mirroring the real schema closely enough for the notify path.
# Echoes the outbound.db path.
seed_notify_root() {
  local root="$1"
  local ag="ag-test" sess="sess-test"
  local v2db="$root/data/v2.db"
  local outdir="$root/data/v2-sessions/$ag/$sess"
  mkdir -p "$(dirname "$v2db")" "$outdir"
  pnpm exec tsx "$REAL_REPO/scripts/q.ts" "$v2db" \
    "CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, channel_type TEXT, instance TEXT, platform_id TEXT);
     CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_group_id TEXT, messaging_group_id TEXT, status TEXT, created_at TEXT);
     INSERT INTO messaging_groups VALUES ('mg-test','telegram','telegram','telegram:42');
     INSERT INTO sessions VALUES ('$sess','$ag','mg-test','active','2026-01-01T00:00:00Z');" >/dev/null
  pnpm exec tsx "$REAL_REPO/scripts/q.ts" "$outdir/outbound.db" \
    "CREATE TABLE messages_out (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, in_reply_to TEXT, timestamp TEXT, deliver_after TEXT, recurrence TEXT, kind TEXT, platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT);" >/dev/null
  echo "$outdir/outbound.db"
}

# --- Test 1: log() outputs with prefix and timestamp ---
echo "Test 1: log() outputs with prefix and timestamp"
output=$(log "hello world")
if echo "$output" | grep -q '\[test\]' && echo "$output" | grep -q 'hello world' && echo "$output" | grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}'; then
  pass "log() output contains prefix, message, and timestamp"
else
  fail "log() output: $output"
fi

# --- Test 2: notify_ren() writes a messages_out row into the active session ---
echo "Test 2: notify_ren() delivers into outbound.db"
notify_root="$TEST_DIR/notify2"
outdb=$(seed_notify_root "$notify_root")
export NANOCLAW_ROOT="$notify_root"
PROJECT_ROOT="$REAL_REPO" notify_ren "Hello from test" >/dev/null 2>&1
row=$(pnpm exec tsx "$REAL_REPO/scripts/q.ts" "$outdb" \
  "SELECT kind || '|' || channel_type || '|' || platform_id || '|' || content FROM messages_out LIMIT 1")
unset NANOCLAW_ROOT
if [ "$row" = 'chat|telegram|telegram:42|{"text":"Hello from test"}' ]; then
  pass "notify_ren() wrote a chat row with correct channel_type, platform_id, content"
else
  fail "notify_ren() row was: $row"
fi

# --- Test 3: notify_ren() preserves special characters in the text ---
echo "Test 3: notify_ren() handles special characters"
notify_root="$TEST_DIR/notify3"
outdb=$(seed_notify_root "$notify_root")
export NANOCLAW_ROOT="$notify_root"
PROJECT_ROOT="$REAL_REPO" notify_ren '*Bold* and "quotes" and
newlines' >/dev/null 2>&1
text=$(pnpm exec tsx "$REAL_REPO/scripts/q.ts" "$outdb" "SELECT content FROM messages_out LIMIT 1")
unset NANOCLAW_ROOT
expected='{"text":"*Bold* and \"quotes\" and\nnewlines"}'
if [ "$text" = "$expected" ]; then
  pass "notify_ren() preserved special characters (newlines, quotes, asterisks)"
else
  fail "notify_ren() content: $text (expected $expected)"
fi

# --- Test 4: notify_ren() fails gracefully when no active Telegram session ---
echo "Test 4: notify_ren() fails gracefully with no active session"
empty_root="$TEST_DIR/notify4"
mkdir -p "$empty_root/data"
pnpm exec tsx "$REAL_REPO/scripts/q.ts" "$empty_root/data/v2.db" \
  "CREATE TABLE messaging_groups (id TEXT, channel_type TEXT, instance TEXT, platform_id TEXT);
   CREATE TABLE sessions (id TEXT, agent_group_id TEXT, messaging_group_id TEXT, status TEXT, created_at TEXT);" >/dev/null
export NANOCLAW_ROOT="$empty_root"
rc=0
# `|| rc=$?` keeps the expected failure from tripping `set -e` in this test.
out=$(PROJECT_ROOT="$REAL_REPO" notify_ren "nobody home" 2>&1) || rc=$?
unset NANOCLAW_ROOT
if [ "$rc" -ne 0 ] && echo "$out" | grep -q "notify_ren delivery failed"; then
  pass "notify_ren() returned non-zero and logged a warning"
else
  fail "notify_ren() rc=$rc out=$out"
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
