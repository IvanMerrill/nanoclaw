# Spec: CLAUDE.md Template System + Autonomous CD Pipeline

**Date:** 2026-03-20
**Status:** Final (post-review)
**Owner:** Ivan Merrill

---

## 1. Problem Statement

NanoClaw's `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md` files serve two purposes:

1. **Upstream capabilities** — tool descriptions, formatting rules, system behavior, admin instructions. These change with every NanoClaw release.
2. **User customizations** — personality (Ren), personal details (Ivan's name, location, wife, ADHD context), email handling rules, trigger name.

These files were recently gitignored (commit `af2914e`) because the user customizations contain personal data unsuitable for a public repo. This means upstream capability updates no longer flow to local groups automatically.

Additionally, the 6-hour fork-sync pipeline (`fork-sync-skills.yml`) needs credentials and expanded test coverage to run as a fully autonomous CD system.

### Goals

1. Upstream CLAUDE.md capability changes flow automatically to all groups without overwriting user customizations.
2. The fork-sync pipeline runs fully autonomously every 6 hours with enough test coverage to catch regressions.
3. Ren (the agent) never loses knowledge of Ivan or its personality during updates.
4. Zero manual intervention for routine updates; GitHub Issues for conflicts.

### Non-Goals

- Scrubbing personal data from git history (separate task, requires BFG/filter-repo).
- Adding new channels or features.
- Rewriting existing tests or achieving 100% coverage.

---

## 2. Design: CLAUDE.md Template System

### 2.1 Architecture: Template + Overlay

Split each CLAUDE.md into two layers:

| Layer | Location | Tracked in git? | Updated by |
|-------|----------|-----------------|------------|
| **Template** | `templates/global.md`, `templates/main.md` | Yes | Upstream merges |
| **User overlay** | `groups/{folder}/CLAUDE.md` | No (gitignored) | User / agent |

**How they combine:** Templates are mounted into containers at `/workspace/templates/` (read-only). The agent-runner loads the appropriate template via `systemPrompt.append` for ALL groups (both main and non-main), followed by the user's overlay content. This is a uniform loading path — no group type gets different treatment.

**Precedence:** Template content comes first (capability docs), then user overlay (personality/preferences). The agent sees both. Later content has mild recency bias in LLM attention, so user personality naturally takes precedence over generic capability docs.

### 2.2 Template Files

Extract the **non-personal** sections from the current CLAUDE.md files into templates:

**`templates/global.md`** — capabilities available to all groups:
- Tool descriptions (web browsing, file I/O, bash, scheduling)
- Communication guidelines (mcp__nanoclaw__send_message usage)
- Internal thoughts syntax
- Message formatting rules (Markdown restrictions)
- Working principles

**`templates/main.md`** — additional admin capabilities for the main group (includes everything in global.md plus):
- Group management (registration, sync, available groups)
- Task scheduling (create, list, pause, cancel)
- IPC task reference
- Container mount documentation
- Multi-channel routing

These templates contain NO personal information — no names, locations, personality traits, or preferences.

### 2.3 Container Mount Changes

**File:** `src/container-runner.ts`

Add a new read-only mount for the templates directory. This goes in `buildVolumeMounts()` for ALL groups (both main and non-main blocks):

```typescript
// Upstream capability templates (read-only, tracked in git)
const templatesDir = path.join(projectRoot, 'templates');
if (fs.existsSync(templatesDir)) {
  mounts.push({
    hostPath: templatesDir,
    containerPath: '/workspace/templates',
    readonly: true,
  });
} else {
  logger.warn('templates/ directory missing — agents will not see upstream capability docs');
}
```

### 2.4 Agent-Runner Changes

**File:** `container/agent-runner/src/index.ts`

Replace the current global CLAUDE.md loading (lines 369-374) with a uniform template + overlay system for ALL groups:

```typescript
// Load upstream capability template (tracked in git, updates from upstream)
const templatePath = containerInput.isMain
  ? '/workspace/templates/main.md'
  : '/workspace/templates/global.md';

const systemPromptParts: string[] = [];

if (fs.existsSync(templatePath)) {
  systemPromptParts.push(fs.readFileSync(templatePath, 'utf-8'));
}

// Load user's global overlay (personality, preferences — gitignored)
// Only for non-main groups (main group's overlay is auto-loaded from cwd)
const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
  systemPromptParts.push(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
}

const systemPromptAppend = systemPromptParts.length > 0
  ? systemPromptParts.join('\n\n---\n\n')
  : undefined;
```

Then in the `query()` call:
```typescript
systemPrompt: systemPromptAppend
  ? { type: 'preset', preset: 'claude_code', append: systemPromptAppend }
  : undefined,
```

**Note on CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD:** This SDK setting is enabled in `settings.json` (container-runner line 164). It auto-discovers CLAUDE.md from the `cwd` (`/workspace/group/`). This means:
- The group's own `groups/{folder}/CLAUDE.md` is auto-loaded by the SDK from the working directory.
- The global overlay is explicitly loaded via `systemPrompt.append` (for non-main groups).
- The template is explicitly loaded via `systemPrompt.append` (for all groups).
- We do NOT add `/workspace/global/` or `/workspace/templates/` to `additionalDirectories` — that would cause double-loading.

### 2.5 Stale Agent-Runner Cache

**File:** `src/container-runner.ts` (lines ~229-248)

The agent-runner source is copied to `data/sessions/{group}/agent-runner-src/` only if the directory doesn't exist. After updating the agent-runner code, existing groups will keep the old version.

**Fix:** Change the copy condition to always overwrite. Replace:
```typescript
if (!fs.existsSync(groupAgentRunnerDir)) {
```
With:
```typescript
// Always sync agent-runner source so code changes take effect immediately
{
```
(Remove the conditional — always copy.)

### 2.6 Template Initialization

When creating the templates for the first time:

1. `templates/global.md` is created with the non-personal capability sections extracted from the current `groups/global/CLAUDE.md`.
2. `templates/main.md` is created with the non-personal admin sections extracted from the current `groups/main/CLAUDE.md`.
3. Existing `groups/*/CLAUDE.md` files need migration (see Section 5).

### 2.7 How Updates Flow

1. Upstream pushes a change to `templates/global.md` (e.g., new tool documentation).
2. The 6-hour pipeline merges `upstream/main` into the fork.
3. `templates/global.md` updates in the tracked repo.
4. Next container startup loads the new template.
5. User's `groups/global/CLAUDE.md` (personality, preferences) is untouched.
6. Agent sees both: updated capabilities + preserved personality.

---

## 3. Design: Autonomous CD Pipeline

### 3.1 Current State

The `fork-sync-skills.yml` workflow exists and handles:
- Fetching upstream, merging, build validation, test validation
- Skill branch propagation
- Auto-issue on failure

**Missing:**
- Credentials (`SYNC_TOKEN` secret) — workflow was updated to use a PAT but secret not yet added by user.
- Test coverage for critical untested modules.
- Template validation in pipeline.
- Test stderr is swallowed (`2>/dev/null`) — failure diagnostics lost.

### 3.2 New Test Coverage

#### 3.2.1 `src/ack.test.ts` — Acknowledgment System (Priority 1)

**Code fix required first:** `src/ack.ts` has two bugs:
1. **Hardcoded "Ren" name** (line 68) — must use `ASSISTANT_NAME` from config. Change `scheduleAck` signature to accept `assistantName: string` parameter, pass it through to `generateAck`.
2. **Timer leak** — the initial `setTimeout` handle is not stored or cleared by `cancel()`. Store it and clear it in cancel.

**Test strategy:** Use `vi.useFakeTimers()` for timing tests. Use `vi.mock('http', ...)` to mock the credential proxy HTTP call.

Tests needed:
- `scheduleAck` returns a cancel function
- Cancel before initial delay prevents ack from firing (advance time, verify sendFn not called)
- Initial ack fires after INITIAL_DELAY_MS with fake timers
- Follow-up acks fire every REPEAT_INTERVAL_MS after initial
- Cancel after initial ack stops follow-up interval
- After cancel, no timers remain active (`vi.getTimerCount()` === 0)
- `generateAck` calls credential proxy on localhost at correct port
- `generateAck` returns null when proxy returns error/non-200
- `generateAck` returns null on network timeout (8s)
- `generateAck` uses different prompt text for follow-up vs initial
- `generateAck` uses assistant name parameter (not hardcoded)
- HTTP request targets `127.0.0.1:CREDENTIAL_PROXY_PORT`, not external API

#### 3.2.2 `src/env.test.ts` — Environment File Reader (Priority 2)

Tests needed:
- Reads key=value pairs from .env file
- Only returns requested keys (filters others)
- Handles double-quoted values
- Handles single-quoted values
- Handles missing .env file gracefully (returns empty object)
- Ignores comments and blank lines
- Handles values containing = signs (e.g., `KEY=base64==`)
- Keys with empty values are omitted (current behavior per line 38)

**Test strategy:** Use `vi.mock('fs', ...)` to mock file reads with known content.

#### 3.2.3 `src/config.test.ts` — Configuration (Priority 2)

Tests needed:
- Default values are correct for all exported constants
- TRIGGER_PATTERN regex matches expected patterns (`@andy`, `@ren`)
- TRIGGER_PATTERN does not match partial strings

**Test strategy:** Config values are module-level constants evaluated at import time. Use `vi.resetModules()` + dynamic `import()` for env override tests. Default value tests can import normally.

#### 3.2.4 Template Loading Tests (Priority 1)

In `src/container-runner.test.ts`:
- Templates directory is included in mount args when it exists
- Warning is logged when templates directory is missing
- Templates mount is read-only

In `container/agent-runner` tests (new file or extend existing):
- Template file content is loaded into systemPromptParts when file exists
- Template is skipped when file doesn't exist
- Main group gets `templates/main.md`, non-main gets `templates/global.md`
- Template content appears before user overlay in combined string
- Template and overlay are separated by `\n\n---\n\n`

### 3.3 Pipeline Enhancements

#### 3.3.1 Coverage Reporting

Add to `vitest.config.ts`:
```typescript
test: {
  coverage: {
    provider: 'v8',
    reporter: ['text', 'json-summary'],
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.test.ts'],
  }
}
```

No enforced thresholds for now — the new tests provide regression coverage. Thresholds can be added once baseline coverage stabilizes.

#### 3.3.2 Fork-Sync Workflow Changes

**File:** `.github/workflows/fork-sync-skills.yml`

1. **Add type check step** — add `npx tsc --noEmit` after `npm ci` and before `npm run build`.
2. **Add template validation** — verify template files exist and are non-empty after merge:
   ```bash
   for f in templates/global.md templates/main.md; do
     if [ ! -s "$f" ]; then
       echo "::error::Template file $f is missing or empty"
       exit 1
     fi
   done
   ```
3. **Stop swallowing test stderr** — remove `2>/dev/null` from `npm test` calls (lines 82 and 140) so test failure diagnostics appear in the workflow logs and can be included in auto-created issues.

#### 3.3.3 CI Workflow Changes

**File:** `.github/workflows/ci.yml`

The CI workflow already has format check, typecheck, and test steps. No changes needed — typecheck is already present.

### 3.4 What "Autonomous" Means

Every 6 hours, without human intervention:

1. **Fetch** upstream changes.
2. **Merge** into fork main (abort + issue if conflicts).
3. **Type check** the merged code.
4. **Build** the merged code.
5. **Validate templates** exist and are non-empty.
6. **Test** the merged code (including template, ack, env, config tests).
7. **Push** to fork main.
8. **Propagate** to skill branches (with same validation per branch).
9. **Issue** on any failure with full diagnostics.

The user wakes up to either:
- Everything updated silently, or
- A GitHub Issue explaining exactly what broke and how to fix it manually.

---

## 4. File Changes Summary

### New Files

| File | Purpose |
|------|---------|
| `templates/global.md` | Upstream capability template for all groups |
| `templates/main.md` | Upstream admin capability template for main group |
| `src/ack.test.ts` | Tests for acknowledgment system |
| `src/env.test.ts` | Tests for .env file reader |
| `src/config.test.ts` | Tests for configuration module |

### Modified Files

| File | Change |
|------|--------|
| `src/ack.ts` | Fix hardcoded "Ren" → use assistant name param; fix timer leak |
| `src/container-runner.ts` | Add templates/ mount for all groups; always sync agent-runner source |
| `container/agent-runner/src/index.ts` | Uniform template + overlay loading for all groups |
| `.github/workflows/fork-sync-skills.yml` | Add typecheck, template validation, remove stderr suppression |
| `vitest.config.ts` | Add coverage configuration |

### No Changes Needed

| File | Why |
|------|-----|
| `.github/workflows/ci.yml` | Already has format check, typecheck, and test steps |
| `groups/*/CLAUDE.md` | Gitignored, user-managed, untouched by code |
| `src/index.ts` | Ack integration works, just pass ASSISTANT_NAME to scheduleAck |

### User-Local Migration (not committed)

| File | Change |
|------|--------|
| `groups/global/CLAUDE.md` | Strip capability docs, keep only personality/personal sections |
| `groups/main/CLAUDE.md` | Replace with minimal scaffold (all capability content moves to template) |
| `data/sessions/*/agent-runner-src/` | Delete directories (auto-recreated on next container start) |

---

## 5. Migration Path

### For Ivan's existing install:

1. `templates/global.md` and `templates/main.md` are created with upstream capability content extracted from the current CLAUDE.md files.
2. **Migrate `groups/global/CLAUDE.md`**: Strip capability sections (tool descriptions, communication guidelines, working principles). Keep ONLY: Ren personality, About Ivan, How You Help Ivan, Email Handling, Trigger, Message Formatting preferences. This prevents duplicate/stale capability docs competing with the template.
3. **Migrate `groups/main/CLAUDE.md`**: This file is currently 100% capability documentation with zero personalization. Replace with a minimal scaffold pointing to the template:
   ```markdown
   # Main Group

   <!-- Admin capabilities are loaded from the upstream template automatically. -->
   <!-- Add any personal overrides or custom instructions below. -->
   ```
4. Delete `data/sessions/*/agent-runner-src/` directories so the updated agent-runner code is re-copied.
5. On next container startup, agents see template + overlay.
6. No personality loss, no capability loss, no manual steps beyond the migration.

### For new NanoClaw installs:

1. Templates ship with the repo.
2. `groups/*/CLAUDE.md` scaffold is created during setup (or by the agent on first run).
3. User customizes their overlay; template updates flow from upstream.

---

## 6. Security Considerations

- **Templates are read-only** in containers — agents cannot modify upstream capability docs.
- **User overlays are writable** — agents can update personality/preferences as before.
- **No secrets in templates** — templates contain only tool documentation and system behavior.
- **Personal data stays local** — `groups/` directory remains gitignored.
- **No hardcoded personal data in source** — `src/ack.ts` uses configurable assistant name, not hardcoded "Ren".
- **Credential proxy auth** — ack system routes through local proxy, never touches API keys directly.
- **PAT scope** — SYNC_TOKEN is fine-grained, scoped to single repo, Contents + Issues only.
- **No additional directories for templates** — templates are loaded explicitly via systemPrompt.append, not via additionalDirectories, to avoid double-loading.

---

## 7. Acceptance Criteria

1. `templates/global.md` exists with all non-personal capability documentation.
2. `templates/main.md` exists with all non-personal admin capability documentation.
3. Container agents load template + user overlay for ALL groups (main and non-main), template first.
4. `src/ack.ts` uses configurable assistant name, not hardcoded "Ren".
5. `src/ack.ts` cancel function clears all timers (no leaks).
6. All new tests pass: ack.test.ts, env.test.ts, config.test.ts.
7. `npm run build` passes.
8. `npm test` passes (excluding pre-existing telegram photo failures).
9. Fork-sync workflow includes typecheck, template validation, and full test stderr output.
10. Coverage configuration is present in vitest.config.ts.
11. No personal data in any tracked file.
12. Existing Ren personality and Ivan's details preserved in local groups/ files.
13. Agent-runner source is always synced (no stale cache).
14. `groups/global/CLAUDE.md` contains only personal/personality content (no stale capability docs).
