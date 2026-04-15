# 03 — Session Commands (`/compact` and `/clear`)

Two orthogonal features, both live in the orchestrator and agent-runner:
- **`/compact`** — comes from upstream's `add-compact` skill (merge `925c12f`). Fork **further customized** it to use per-group trigger patterns.
- **`/clear`** — fork-native. Archives transcript to `conversations/` before SDK discards context.

## Host-side interception (`src/session-commands.ts`)

**Files:** `src/session-commands.ts` (+ `.test.ts`), integrated into `src/index.ts`.

**Intent:** Intercept recognized session commands BEFORE normal trigger/agent processing. Process preceding messages into session context first, then run the command, then leave trailing messages pending for next poll.

**API:**
```typescript
extractSessionCommand(content: string, triggerPattern: RegExp): '/compact' | null
isSessionCommandAllowed(isMainGroup: boolean, isFromMe: boolean): boolean
handleSessionCommand(...) // runs pre-command messages, runs command, advances cursor
```

**Auth model:**
- Main group: any sender can use session commands.
- Non-main groups: only `is_from_me` (trusted sender) can. Denied senders get: `"Session commands require admin access."` (if they would otherwise be allowed to interact; else silently consumed).

**Per-group trigger pattern (the fork's customization):**
Replace all three call sites that hardcode the global `TRIGGER_PATTERN` with `getTriggerPattern(group.trigger)`:
1. In `src/index.ts` message loop when extracting command from message content
2. In the "should trigger agent" check
3. In the session-command path itself

`getTriggerPattern(groupTrigger: string | null): RegExp` — returns a RegExp matching the group's configured trigger (e.g. `@Ren`, `!`, or empty/match-anything). Falls back to the global `TRIGGER_PATTERN` if group has none configured. Define this next to the global pattern in the config module.

**Orchestrator integration point (`src/index.ts`):**
```typescript
// Before normal trigger/agent processing:
const cmd = extractSessionCommand(message.content, getTriggerPattern(group.trigger));
if (cmd) {
  const result = await handleSessionCommand({ cmd, group, preMessages, ... });
  if (result.handled) continue; // skip normal agent run
}
```

## Container-side slash-command handling (`container/agent-runner/src/index.ts`)

**Intent:** When Ren's input is literally `/compact` or `/clear`, handle specially via the Claude Agent SDK's built-in slash-command mechanism.

**Known commands (hardcoded set):** `{ '/compact', '/clear' }`. If the user prompt matches exactly one of these (after trimming), the runner routes through the slash-command path. Otherwise treat as a regular prompt.

**`/compact` behavior:**
1. Call `query()` with `prompt = '/compact'`, `resume = sessionId`, and empty `allowedTools` (bypass all tool restrictions).
2. Observe `system/compact_boundary` message in the stream to confirm SDK compaction completed.
3. Extract new session ID from the subsequent `system/init` message; return as `newSessionId`.
4. If `compact_boundary` is never seen, log warning but still return success.

**`/clear` behavior:**
1. Call `archiveCurrentSession()` FIRST — before the SDK discards context.
2. Archive writes to `/workspace/group/conversations/YYYY-MM-DD-{slug}.md`.
3. Format: markdown with `## {senderName} — {timestamp}` headers, each message body truncated to 2000 chars.
4. `{slug}` is derived from the session's first user message or a UUID fallback.
5. After archive, invoke SDK's `/clear` to reset context. Return new sessionId.

**Crucial — `/clear` is different from `/compact`:**
- `/compact` preserves continuity (SDK compacts, session continues).
- `/clear` fully resets context — the archive is the ONLY record of what was said.

## Container-side transcript archival detail

`archiveCurrentSession()`:
- Reads session messages from SDK's session-store path (container has `/workspace/group/.session-store/`)
- Writes markdown to `/workspace/group/conversations/YYYY-MM-DD-{slug}.md`
- Overwrites if file exists (same-day same-slug)
- Does NOT delete the session-store — SDK handles that

## How to apply on v2

1. **Add `add-compact` functionality.** v2 may have the skill already — check `.claude/skills/add-compact/` on v2. If it exists and matches, use it. If not, port `src/session-commands.ts` + `.test.ts` + orchestrator wiring to v2's equivalent paths.

2. **Add per-group trigger pattern.** This is the only user-modification-on-top-of-skill. Find where v2 reads `TRIGGER_PATTERN` (or whatever v2 renames it to) and introduce the same `getTriggerPattern(group.trigger)` shim, plumbed through the three call sites.

3. **Add `/clear` archival.** v2's agent-runner likely handles `/clear` already (SDK feature), but not the archival. Find where v2 dispatches slash commands and wrap `/clear` to call `archiveCurrentSession()` first.

4. **Preserve the KNOWN set.** Do not extend to other commands like `/reset`, `/rewind` — the fork intentionally only recognizes `/compact` and `/clear`.

## Testing checklist

- [ ] `/compact` in main group compacts context without resetting
- [ ] `/compact` from trusted sender in non-main group works
- [ ] `/compact` from untrusted sender in non-main group returns "Session commands require admin access."
- [ ] `/clear` in main group archives then resets
- [ ] Archive file exists at `/workspace/group/conversations/YYYY-MM-DD-*.md` after `/clear`
- [ ] Per-group trigger: a group configured with `group.trigger='!'` accepts `!/compact` but rejects `@Ren /compact`
- [ ] A group with `group.trigger=null` falls back to global `TRIGGER_PATTERN`

## Migration risk

- **Medium:** v2's SDK version may handle `/compact` differently. The `compact_boundary` message name/shape may have changed. Check `@anthropic-ai/claude-agent-sdk` release notes for v2's pinned version.
- **Low:** archive path changes. If v2 relocates `/workspace/group/` to a different container mount, update `archiveCurrentSession()` accordingly.
