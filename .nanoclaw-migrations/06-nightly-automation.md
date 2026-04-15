# 06 — Nightly Automation Scripts

Three bash scripts + one shared helper library + supporting launchd plists. Entirely self-contained under `scripts/` + `launchd/` + `start-nanoclaw.sh`. Can be ported after the core migration is working.

## Shared infrastructure (`scripts/nightly-common.sh`)

**Intent:** Source file, not executable. Every auto-*.sh script sources it at top for shared helpers.

**Provides:**
- **Mise activation** — sources `$HOME/.local/share/mise/shims/mise env` so `node`, `npm`, `claude` are in PATH under launchd's minimal environment.
- **PATH fallback** — appends `/opt/homebrew/bin:/usr/local/bin`.
- `log()` — timestamped log line `[{LOG_PREFIX} YYYY-MM-DD HH:MM:SS] message`.
- `resolve_main_chat_jid()` — `sqlite3 $PROJECT_ROOT/store/messages.db "SELECT jid FROM registered_groups WHERE is_main=1 LIMIT 1"`.
- `notify_ren(message)` — writes JSON `{type: "message", chatJid, text}` to `$PROJECT_ROOT/data/ipc/telegram_main/messages/nightly-{timestamp}-{pid}.json`. Ren's IPC watcher picks it up.
- `setup_worktree()` — creates `$PROJECT_ROOT/.worktrees/${JOB_NAME}-$(date +%Y%m%d-%H%M%S)` from `main`. Cleans prior stale branches first (`git branch -D`).
- `cleanup_worktree()` — removes worktree + branch.
- `push_and_pull()` — `git push origin <worktree-branch>:main` then `git pull --ff-only origin main` into `$PROJECT_ROOT`.
- `rebuild_container()` — runs `container/build.sh` with `CONTAINER_RUNTIME=docker` (or inherit from env).
- `restart_and_verify(commit_desc)` — `launchctl kickstart -k "gui/$(id -u)/com.nanoclaw"`; sleep 8; check `pgrep -f "node.*dist/index.js"`. On failure, `git revert HEAD --no-edit`, rebuild, push, restart. On persistent failure, notify with "CRITICAL".

**Required variables** (set before sourcing): `PROJECT_ROOT`, `LOG_PREFIX`, `JOB_NAME`.

## `auto-upstream-sync.sh`

**Schedule:** Daily 03:30 local time (launchd plist).
**Purpose:** Fetch upstream, if new commits exist launch Claude Code to run `/update-nanoclaw` and handle review/rebuild/push/restart.
**Notable behavior:**
- Hardcoded upstream remote: `qwibitai` — **this is the user's naming**. On v2, may prefer renaming to `upstream`. The script uses `git fetch qwibitai` and `HEAD..qwibitai/main`.
- `--dry-run` flag: count new commits and exit without invoking Claude Code.
- Launches `claude -p "<prompt>"` with `--allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,Skill"`.
- Prompt tells Claude to: run `/update-nanoclaw`, update only relevant features (the user uses Telegram not WhatsApp, so skip WhatsApp-only changes), push to GitHub, restart Ren, and if startup fails, roll back + Telegram notification.
- Output teed to `logs/upstream-sync.log`.

**The bug discussed with the user:** this script targets `upstream/main` (actually `qwibitai/main`). It never surfaced v2 activity because v2 commits land on `upstream/v2`. If the user wants the script to track v2 post-migration, either rename the target branch in the script, or add a second script for v2-specific syncs. **Recommendation:** after migration to v2, point the script at `upstream/v2` (v2 is the active branch).

## `auto-update-deps.sh`

**Schedule:** Daily 04:30 local time.
**Purpose:** Dependency bumps.
**Modes:**
- **Minor mode** (Mon–Sat): `npm update` in host + `container/agent-runner` + `container/nanoclaw-google-mcp`. Rebuild, test. If any changes: commit as `chore: automated dependency update YYYY-MM-DD`, rebuild container, restart.
- **Major mode** (Sundays, `date +%u == 7`): run minor first, then scan `npm outdated` for major bumps. For each major: WebSearch changelog, classify as APPLY / REVIEW / SKIP. APPLY gets installed + tested + committed individually; REVIEW/SKIP are logged for manual handling.
- Auto-rollback via `restart_and_verify()` on startup failure.

## `auto-system-maintenance.sh`

**Schedule:** Daily (launchd-controlled time).
**Purpose:** OS-level housekeeping, no Claude session.
**Steps:**
1. `mise upgrade --yes` — update Node/runtime
2. `mise prune --yes` — clean old cached versions
3. `docker system prune -f --filter "until=168h"` — remove 7+-day-unused Docker artifacts
4. Disk space check: warn if `/` has < 20 GB free

## `start-nanoclaw.sh`

**Purpose:** Manual restart outside launchd. Not invoked by launchd itself.
**Logic:**
1. If `$PROJECT_ROOT/nanoclaw.pid` exists and process is alive, `kill` it
2. `nohup node dist/index.js > logs/nanoclaw.log 2> logs/nanoclaw.error.log &`
3. Write new PID to `nanoclaw.pid`

## launchd plists

Main plist (`launchd/com.nanoclaw.plist`) is shipped by upstream and probably unchanged between main and v2 — verify.

Nightly job plists are likely NOT tracked in git currently (based on analysis). If they exist only in `~/Library/LaunchAgents/`, they need to be created after migration. Templates:

| Label | StartCalendarInterval | ProgramArguments |
|---|---|---|
| `com.nanoclaw.upstream-sync` | Hour=3 Minute=30 | `$PROJECT_ROOT/scripts/auto-upstream-sync.sh` |
| `com.nanoclaw.update-deps` | Hour=4 Minute=30 | `$PROJECT_ROOT/scripts/auto-update-deps.sh` |
| `com.nanoclaw.system-maintenance` | Hour=5 Minute=0 | `$PROJECT_ROOT/scripts/auto-system-maintenance.sh` |

Stdout/stderr to `logs/{upstream-sync,update-deps,system-maintenance}.log`.

## `.gitignore` additions

```
groups/                  # per-group memory — personal data, gitignored
credentials.json         # any stray OAuth credential drops
.worktrees/              # ephemeral worktree dirs
nanoclaw.pid             # PID file
```

## `.env.example` additions

```
# Telegram bot token (required for Telegram channel)
TELEGRAM_BOT_TOKEN=

# true if Ren has a dedicated number/bot account; false on shared
ASSISTANT_HAS_OWN_NUMBER=
```

## How to apply on v2

1. Copy `scripts/nightly-common.sh` + the three `auto-*.sh` scripts wholesale — they don't depend on NanoClaw source structure, only on filesystem paths (`data/ipc/...`, `store/messages.db`, `launchctl kickstart com.nanoclaw`).
2. Review notify_ren's IPC path: `data/ipc/telegram_main/messages/`. If v2 relocates IPC, adjust.
3. `restart_and_verify`'s pgrep pattern `"node.*dist/index.js"` — adjust if v2 uses a different dist path or launcher.
4. `auto-upstream-sync.sh`: change target branch from `qwibitai/main` to `upstream/v2` (now that user is on v2).
5. `auto-update-deps.sh`: the three trees (`.`, `container/agent-runner`, `container/nanoclaw-google-mcp`) should still be valid on v2 if Google MCP is preserved (see `01-channels-and-google.md`).
6. Install launchd plists after migration; don't auto-load until user confirms migration succeeded.

## Testing checklist

- [ ] `./scripts/auto-upstream-sync.sh --dry-run` prints commit count and exits 0
- [ ] `notify_ren "test"` results in Telegram message delivered via Ren
- [ ] `setup_worktree` + `cleanup_worktree` dance leaves repo unchanged
- [ ] `restart_and_verify` on a clean state returns 0 without reverting
- [ ] `auto-update-deps.sh --dry-run` (if implemented) reports pending updates

## Migration risk

- **Low:** These scripts are entirely external to NanoClaw source. Port last — they don't block migration validation.
- **Medium:** `restart_and_verify` calls `launchctl kickstart com.nanoclaw`. If v2 uses a different launchd label or uses systemd patterns, update.
- **Worth noting:** Don't enable the nightly launchd jobs until the main migration has been running for at least 24–48 hours manually. A broken nightly on day 1 of v2 could rollback or destabilize the migration itself.
