#!/bin/bash
# Tests for scripts/auto-update-deps.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TESTS_PASSED=0
TESTS_FAILED=0

pass() { echo "  PASS: $1"; TESTS_PASSED=$((TESTS_PASSED + 1)); }
fail() { echo "  FAIL: $1"; TESTS_FAILED=$((TESTS_FAILED + 1)); }

# --- Test 1: Default mode is minor on non-Sunday ---
echo "Test 1: Default mode is minor on non-Sunday"
output=$(bash "$SCRIPT_DIR/auto-update-deps.sh" --dry-run 2>&1)
DAY_OF_WEEK=$(date +%u)
if [ "$DAY_OF_WEEK" = "7" ]; then
  if echo "$output" | grep -q "Mode: major"; then
    pass "Mode is major (today is Sunday, expected)"
  else
    fail "Expected 'Mode: major' on Sunday, got: $output"
  fi
else
  if echo "$output" | grep -q "Mode: minor"; then
    pass "Mode is minor on non-Sunday (day $DAY_OF_WEEK)"
  else
    fail "Expected 'Mode: minor' on non-Sunday, got: $output"
  fi
fi

# --- Test 2: --major flag forces major mode ---
echo "Test 2: --major flag forces major mode"
output=$(bash "$SCRIPT_DIR/auto-update-deps.sh" --major --dry-run 2>&1)
if echo "$output" | grep -q "Mode: major"; then
  pass "--major flag forces major mode"
else
  fail "Expected 'Mode: major' with --major flag, got: $output"
fi

# --- Test 3: --dry-run exits cleanly with exit code 0 ---
echo "Test 3: --dry-run exits cleanly with exit code 0"
if bash "$SCRIPT_DIR/auto-update-deps.sh" --dry-run >/dev/null 2>&1; then
  pass "--dry-run exits with code 0"
else
  fail "--dry-run exited with non-zero code $?"
fi

# --- Test 4: --dry-run outputs package tree headers ---
echo "Test 4: --dry-run outputs package tree headers"
output=$(bash "$SCRIPT_DIR/auto-update-deps.sh" --dry-run 2>&1)
missing=""
echo "$output" | grep -q "=== Host ===" || missing="$missing Host"
echo "$output" | grep -q "=== agent-runner ===" || missing="$missing agent-runner"
echo "$output" | grep -q "=== google-mcp ===" || missing="$missing google-mcp"
if [ -z "$missing" ]; then
  pass "--dry-run outputs all three package tree headers"
else
  fail "Missing headers:$missing"
fi

# --- Test 5: --dry-run does not create a worktree ---
echo "Test 5: --dry-run does not create a worktree"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
worktree_dir="$PROJECT_ROOT/.worktrees"
# Record state before
if [ -d "$worktree_dir" ]; then
  before=$(ls "$worktree_dir" 2>/dev/null | wc -l | tr -d ' ')
else
  before=0
fi
bash "$SCRIPT_DIR/auto-update-deps.sh" --dry-run >/dev/null 2>&1
if [ -d "$worktree_dir" ]; then
  after=$(ls "$worktree_dir" 2>/dev/null | wc -l | tr -d ' ')
else
  after=0
fi
if [ "$after" -le "$before" ]; then
  pass "--dry-run did not create a worktree"
else
  fail "--dry-run created worktree entries (before=$before, after=$after)"
fi

# --- Test 6: Script sources nightly-common.sh successfully ---
echo "Test 6: Script sources nightly-common.sh successfully"
output=$(bash "$SCRIPT_DIR/auto-update-deps.sh" --dry-run 2>&1)
if echo "$output" | grep -q "\[update-deps\]"; then
  pass "Script sources nightly-common.sh and uses [update-deps] prefix"
else
  fail "Output missing [update-deps] prefix, got: $output"
fi
if echo "$output" | grep -qi "source.*not found\|cannot open\|No such file"; then
  fail "Script had source errors"
else
  pass "No source errors detected"
fi

# --- Test 7: Both flags combine correctly ---
echo "Test 7: Both flags combine correctly"
output=$(bash "$SCRIPT_DIR/auto-update-deps.sh" --major --dry-run 2>&1)
has_major=false
has_dry=false
echo "$output" | grep -q "Mode: major" && has_major=true
echo "$output" | grep -q "Dry run" && has_dry=true
if [ "$has_major" = true ] && [ "$has_dry" = true ]; then
  pass "--major --dry-run outputs both 'Mode: major' and 'Dry run'"
else
  fail "Expected both 'Mode: major' and 'Dry run', got major=$has_major dry=$has_dry"
fi

echo ""
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
[ "$TESTS_FAILED" -eq 0 ] || exit 1
