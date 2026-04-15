# 05 — Task Scheduler (DST, `allowed_tools`, Notifications, `spawn_agent`)

Everything scheduling-related that's been customized. These all touch the same `scheduled_tasks` DB table and `task-scheduler.ts` execution path.

## DB schema migration — `allowed_tools` column

**Files:** `src/db.ts` (M), `src/db-migration.test.ts` (A), `src/types.ts` (M).

**Intent:** Each scheduled task can restrict which tools the agent invocation may call. NULL = default allowlist; JSON-array string = override.

**Schema addition:**
```sql
ALTER TABLE scheduled_tasks ADD COLUMN allowed_tools TEXT; -- nullable JSON array
```

**v2 migration:** Add a new migration file to v2's DB migration runner. User confirmed in Extract phase: preserve this column.

**How to apply:**
1. Locate v2's DB migration mechanism (check `src/db.ts` on v2 for how migrations are tracked — likely a `schema_version` table with an array of migrations).
2. Add migration: `ALTER TABLE scheduled_tasks ADD COLUMN allowed_tools TEXT;`
3. Ensure existing rows (NULL) continue to behave as "use default allowlist" — no data conversion needed.
4. Update `ScheduledTask` type in `types.ts` equivalent: `allowed_tools: string | null`.
5. Update `createTask()` / `updateTask()` to accept and persist the field.
6. Update task execution path to pass `allowed_tools` (parsed) into the container's `ContainerInput.allowedTools`.

**IPC-side enforcement** (from `04-router-and-security.md`): strip `mcp__google__send_email` from `allowed_tools` in `schedule_task` IPC requests with logged warning.

## DST-safe cron parsing (`src/task-scheduler.ts`)

**Intent:** `cron-parser` v5 has a bug where DST spring-forward causes daily crons to skip a day (computed "next" is 25+ hours away, so some evaluations miss the real slot).

**`parseCronNextSafe(cronExpr, fromDate)`:**
1. Call normal `CronExpression.parse(...).next()`.
2. If computed `next - fromDate > 25h`:
   - Scan forward in 1-hour steps from `fromDate`, evaluating the cron at each step
   - Return the first match found (will be ≤ 24h away in normal weeks)
3. Otherwise return the original `next`.

Wrap EVERY cron evaluation in the scheduler loop with this function. Do not call `.next()` directly.

## Error notifications

**Intent:** When a scheduled task fails (agent throws, non-zero exit, timeout), send a Telegram message to the owning chat with diagnostic info.

**Message format:**
```
⚠️ Scheduled task failed
Prompt: {first 80 chars of task.prompt}...
Error: {first 300 chars of error message}
```

Sent via the standard outbound path (so it flows through router → redact → channel). Include the task id and next-run time if available.

## `spawn_agent` sub-agents

**Files:** `container/agent-runner/src/ipc-mcp-stdio.ts` (M) — this is container-side. Host-side tracking in `src/ipc.ts`.

**Intent:** Allow an agent to delegate to a sandboxed sub-agent with a restricted tool set. E.g. classify emails with read-only tools first, then apply labels with write tools only if classification returns a decision.

**Tool signature (exposed to Ren):**
```
spawn_agent(prompt: string, allowed_tools: string[], description?: string) → string
```

**Flow:**
1. Container-side MCP tool writes request to `/workspace/ipc/tasks/spawn_request_{requestId}.json`
2. Host picks up the request, checks `MAX_SPAWN_AGENTS` cap, spawns a new nanoclaw container with the specified `allowed_tools` (plus `isScheduledTask=true` for single-turn behavior)
3. Sub-agent runs, writes final output to `/workspace/ipc/tasks/spawn_result_{requestId}.json` on the host
4. Container-side blocks on polling the result file, 300s timeout
5. Returns the result string to the caller

**Host-side additions to container-runner:**
- `ContainerInput.allowedTools: string[]` (override full list)
- `ContainerInput.additionalAllowedTools: string[]` (extend default)
- Concurrency tracking — reject if >= 3 in-flight

## Scheduled-task container semantics

**Intent:** Scheduled tasks run single-turn (not multi-turn like interactive groups).

**Flag:** `ContainerInput.isScheduledTask: boolean`. When true:
- Stream ends immediately after the agent's first response
- No IPC polling during the query
- Writable transcripts still archived (for `/clear` consistency)
- `send_email` is NOT in the default allowlist (enforced at IPC layer as well)

## How to apply on v2

1. **DB migration first.** Before any task-scheduler code, ensure v2's migration runner includes the `allowed_tools` column add. Stage this as a schema migration that runs on first startup after upgrade.
2. **Task-scheduler module.** Find v2's scheduler (may be `src/task-scheduler.ts` preserved, or moved — check v2 structure). Wrap cron evaluation with `parseCronNextSafe`.
3. **Error notification hook.** Find where task execution captures errors. Add the Telegram notification dispatch (through the outbound channel path so redaction applies).
4. **`spawn_agent` tool** — add to v2's container-side MCP tools. Add host-side handler alongside existing scheduled-task IPC handlers.

## Testing checklist

- [ ] On first startup after upgrade, `allowed_tools` column exists in `scheduled_tasks`
- [ ] Existing scheduled tasks (with NULL `allowed_tools`) continue to run with default tools
- [ ] A task with `allowed_tools=["mcp__google__search_emails"]` cannot call `mcp__google__send_email`
- [ ] Manually set a task's cron to just-after-DST-transition time; `parseCronNextSafe` returns a time within 24h (not 48h)
- [ ] A task whose agent throws sends Telegram error notification with truncated prompt + error
- [ ] `spawn_agent("test", ["Read"])` runs a sub-container and returns its output
- [ ] 4 concurrent `spawn_agent` calls — the 4th gets rejected
- [ ] IPC `schedule_task` with `send_email` in tools has it stripped with log warning

## Migration risk

- **High:** DB migration. If v2 already uses a different schema for scheduled tasks (or a different storage entirely), the user's existing rows may need manual migration. Inspect `nanoclaw.db` schema BEFORE applying v2. If rows are lost, reminders are lost — that's a data-loss scenario the user explicitly asked to avoid.
  - **Mitigation:** Before running v2 for the first time, take a SQL dump: `sqlite3 nanoclaw.db .dump > nanoclaw.sqldump.bak`. If schema diverges significantly, write an adapter script to recreate scheduled tasks on v2's schema.
- **Medium:** `parseCronNextSafe` depends on `cron-parser` version. v2 may pin a different version that has fixed this bug natively — check release notes; if fixed, skip the wrapper.
- **Low:** `spawn_agent` semantics require host-side concurrency tracking compatible with v2's container lifecycle. Verify v2's container-runner exposes the same signals.
