# 04 — Router, Security, IPC Hardening

All the "nothing bad gets out, nothing bad gets in" customizations. Treat these as defense-in-depth — apply all of them; skipping any weakens the whole.

## Router output filtering (`src/router.ts` + `src/redact.ts`)

**Files:** `src/router.ts` (M), `src/redact.ts` (A + `.test.ts`).

**Intent:** Every outbound message passes through `formatOutbound()` which:
1. Strips `<internal>...</internal>` blocks (Claude's internal reasoning — should never be user-visible)
2. Redacts any token/key/secret patterns
3. Replaces catbox/litterbox file-upload links with a placeholder

**Redaction patterns** (`redactSecrets(text) → text`):
- GitHub PAT classic: `ghp_[A-Za-z0-9]{36}`
- GitHub PAT fine-grained: `github_pat_[A-Za-z0-9_]{82}`
- Anthropic SK: `sk-ant-api[A-Za-z0-9_-]+`
- OpenAI: `sk-[A-Za-z0-9]{20,}` (broad; may over-match, accept that)
- Slack: `xoxb-[A-Za-z0-9-]+`, `xoxp-[A-Za-z0-9-]+`
- Telegram bot token: `\d{9,12}:[A-Za-z0-9_-]{35}`
- Discord bot: `[A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}`
- AWS access key: `AKIA[0-9A-Z]{16}`
- Replace all with `[REDACTED]`.

**Catbox/litterbox strip** (commit `9f6e4f4` intent):
- Pattern: `https?://(?:\w+\.)?(?:catbox\.moe|litterbox\.catbox\.moe)/\S+`
- Replacement: `[Link removed — files are sent as attachments]`
- Rationale: Ren sometimes suggests uploading via catbox; users should get attachments directly instead.

**`<internal>` tag strip:** regex removes `<internal>[\s\S]*?</internal>` blocks before further processing.

**Order matters:** strip `<internal>` first (may contain secrets), THEN redact secrets, THEN strip catbox links. Reason: an `<internal>` block could reference a secret that would otherwise leak.

## Ack timeouts (`src/ack.ts`)

**Files:** `src/ack.ts` (A + `.test.ts`), integrated in `src/index.ts`.

**Intent:** If the agent takes >10s to produce first output, send a lightweight "working on it" message via Haiku. Repeat every 60s until cancelled.

**API:**
```typescript
scheduleAck(messagePreview: string, assistantName: string, sendFn: (text: string) => Promise<void>): () => void
```
Returns cancel function. Start the timer right after launching the agent query; cancel on first streamed output.

**Haiku call:** via credential proxy at `127.0.0.1:${CREDENTIAL_PROXY_PORT}`, model `claude-haiku-4-5-20251001` (see assistant knowledge — latest Haiku). Prompt: generate 1 short sentence (<15 words) acknowledging work-in-progress, in Ren's voice. System: provide `assistantName` and first 100 chars of the original message.

**Intervals:**
- `INITIAL_DELAY_MS = 10_000`
- `REPEAT_INTERVAL_MS = 60_000`

## IPC hardening (`src/ipc.ts`)

**Files:** `src/ipc.ts` (M), `src/ipc-ratelimit.test.ts` (A), `src/ipc-spawn.test.ts` (A), `src/ipc-auth.test.ts` (A — augmented).

**Intent:** Prevent a malfunctioning or malicious agent from flooding the host.

**Guards:**
1. **File size cap:** `MAX_IPC_FILE_SIZE = 1_048_576` (1 MB). Oversized IPC message files logged + unlinked.
2. **Per-group rate limit:** 20 messages/minute. Track with sliding-window timestamps per `chatJid`. Exceeds are logged + dropped.
3. **Spawn cap:** `MAX_SPAWN_AGENTS = 3` concurrent sub-containers. `spawn_agent` requests past the cap are rejected with error written back to the result file.
4. **`send_email` gate in scheduled tasks:** if an IPC `schedule_task` request includes `mcp__google__send_email` in its `allowed_tools`, strip it with a logged warning. Only interactive messages may authorize send_email.

## Mount security (`src/mount-security.ts`)

**Files:** `src/mount-security.ts` (M), `src/mount-security.test.ts` (A).

**Intent:** Agents can request additional bind-mounts for a task. This must be allowlist-gated.

**Config file:** `~/.config/nanoclaw/mount-allowlist.json`
```json
{
  "allowedRoots": ["/Users/ivan/Documents", "/Users/ivan/code"],
  "blockedPatterns": [".ssh", ".gnupg", ".aws", ".kube", "credentials"],
  "nonMainReadOnly": true
}
```

**`validateAdditionalMounts(mounts, isMainGroup)`:**
- For each mount: resolve symlinks, check against `allowedRoots` prefix match
- Reject any path matching `blockedPatterns` anywhere in the resolved path
- If `nonMainReadOnly=true` and `isMainGroup=false`, force all mounts to read-only regardless of requested mode
- Throw on violation — no silent downgrade

**Env override:** `MOUNT_ALLOWLIST_PATH` — override default config location.

## Path safety (`src/group-folder.ts`)

**Files:** `src/group-folder.ts` (A + `.test.ts`).

**Intent:** Prevent directory traversal via crafted group folder names in IPC messages.

**APIs:**
- `isValidGroupFolder(folder): boolean` — alphanumeric + `_`/`-` only, 1–64 chars, rejects `..`, `/`, `\`, `"global"` (reserved)
- `resolveGroupFolderPath(folder): string` — joins with base, verifies `path.relative(base, resolved)` doesn't start with `..`
- `resolveGroupIpcPath(folder, subpath): string` — same check for IPC sub-paths

Use these EVERYWHERE instead of raw `path.join` when the input comes from IPC/DB (group folder names).

## Sender allowlist caching (`src/sender-allowlist.ts`)

**Files:** `src/sender-allowlist.ts` (M).

**Intent:** Avoid re-parsing the allowlist JSON on every message.

**Cache:** `cachedConfig` + `CACHE_TTL_MS = 30_000`. Bypass cache if a `pathOverride` is passed (for tests).

Not security-critical, but keep this — it matters for throughput on high-traffic groups.

## DB message truncation (`src/db.ts`)

**File:** `src/db.ts` (M).

**Intent:** Cap stored message content at 10 KB to prevent unbounded DB growth from malicious or accidental huge pastes.

**Behavior:** In `storeMessage()`, if `msg.content.length > 10_000`, truncate and append `\n[Message truncated]`.

## How to apply on v2

On v2's new architecture:
1. Find v2's outbound routing function (likely not called `router.ts` — may be `delivery.ts` or similar). Add the three-step `formatOutbound` pipeline.
2. Create `redact.ts` as a standalone pure-function module; import into the router.
3. For `ack.ts` — v2's agent-invocation point is the integration site. Wrap the query with the ack scheduler.
4. For IPC hardening — v2 has its own IPC handler. Add the four guards (size, rate, spawn, send_email filter) in the appropriate validation layer.
5. For mount-security — v2's container-runner has a mount-building path. Insert `validateAdditionalMounts` on any user-provided mount.
6. For group-folder safety — search v2 for any `path.join(<base>, group.folder, ...)` pattern and replace with the safe resolver.
7. For sender-allowlist cache — if v2 moved sender allowlist logic, reapply the 30s cache decorator.
8. For DB truncation — trivial, reapply in v2's `storeMessage` equivalent.

## Testing checklist

- [ ] Message containing `sk-ant-api03-XXX...` in the middle gets redacted to `[REDACTED]`
- [ ] Message containing `<internal>secret: sk-ant-api03-...</internal>` gets the whole block stripped (no leak)
- [ ] Message with `https://files.catbox.moe/abc123.png` gets the placeholder
- [ ] Ack timer fires after 10s, then every 60s
- [ ] IPC file > 1MB is deleted with log entry
- [ ] 21st message to a group within 60s gets dropped
- [ ] 4th concurrent `spawn_agent` gets rejected
- [ ] `schedule_task` with `send_email` in allowed_tools has it stripped
- [ ] Mount request for `/Users/ivan/.ssh` throws
- [ ] `group.folder = '../etc'` in an IPC message is rejected by `isValidGroupFolder`
- [ ] Large paste (>10KB) in a message is truncated in DB with marker
