# 07 — Container, Agent-Runner, Template Refactor

Everything container-side plus the `templates/` directory reshuffle. These are more "straightforward to port" than the earlier sections; less intent-heavy, more mechanical.

## Dockerfile (`container/Dockerfile`)

**Fork state:**
- Base: `FROM node:24-trixie-slim` (was `node:22-slim` on upstream base).
- Accepts build args: `http_proxy`, `https_proxy`, `no_proxy`, `NODE_EXTRA_CA_CERTS`.
- Disables strict SSL during `npm ci` for MITM-proxy environments, then re-enables after build.
- **Removes** `fonts-noto-cjk` (space saver).
- **Adds** GitHub CLI (`gh`) via keyring + APT.
- Builds `nanoclaw-google-mcp` alongside agent-runner:
  ```dockerfile
  COPY nanoclaw-google-mcp ./nanoclaw-google-mcp
  RUN cd nanoclaw-google-mcp && npm ci && npm run build
  ```
- Entrypoint: node reads stdin from `/tmp/input.json`, runs `/tmp/dist/index.js`.
- No `USER node` (removed — caused workdir permission issues).

## `container/build.sh`

- Default `CONTAINER_RUNTIME=container` (Apple Container). Allow override via env.
- Inherits proxy env vars into `--build-arg` automatically:
  ```bash
  for var in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    if [ -n "${!var}" ]; then
      PROXY_ARGS="$PROXY_ARGS --build-arg $var=${!var}"
    fi
  done
  ```

## `container/agent-runner/src/index.ts`

Already covered in other sections for specific behaviors:
- `GOOGLE_SAFE_TOOLS` + mcpServers config for Google MCP — see `01-channels-and-google.md`
- `archiveCurrentSession()` on `/clear` — see `03-session-commands.md`
- `DEFAULT_ALLOWED_TOOLS`, `spawn_agent` result file polling — see `05-task-scheduler.md`

**Remaining agent-runner changes to apply:**
- `ContainerInput` extended with `allowedTools?: string[]`, `additionalAllowedTools?: string[]`, `isScheduledTask?: boolean`.
- Explicit `process.exit(0)` after query loop ends — prevents hanging on dangling SDK/MCP event loops (was timing out at 30 min in fork's upstream base, may be fixed in v2's SDK pinning — verify).
- `KNOWN_SESSION_COMMANDS = new Set(['/compact', '/clear'])` for slash-command routing.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=165000` env (tune for context headroom).

## `container/.claude/settings.json`

**Contents:**
```json
{
  "enabledPlugins": {
    "nanoclaw-skills@nanoclaw-skills": true
  }
}
```
Enables container-side skills plugin loaded into the Claude Agent SDK.

## `container/skills/` — NO fork changes

Upstream-managed container-side skills (agent-browser, status, slack-formatting, capabilities). Do not override; v2 will ship updated versions — prefer v2's.

## Host-side container wiring (`src/container-runner.ts`, `src/container-runtime.ts`)

**Mount order for main group:**
1. Project root (ro)
2. `.env` shadow (ro — mounts `/dev/null` over the in-container `.env` path to prevent env leakage)
3. `CLAUDE.md` (RW if exists — agents can self-update project docs)
4. `store/` (rw)
5. `global/` (rw if exists — user overlay)
6. `group/` (rw)
7. `templates/` (ro — universal capability docs, see below)

**`hostGatewayArgs()` for Linux:**
```
--add-host=host.docker.internal:host-gateway
```
(macOS and Apple Container get this built-in; bare Linux doesn't.)

**`readonlyMountArgs()`:** use `--mount type=bind,source=...,target=...,readonly` instead of `-v ...:ro` (better Docker audit trail and consistent with apple-container).

**`PROXY_BIND_HOST` detection** (used for credential proxy / token vendor listen address):
- macOS / WSL: `127.0.0.1`
- Bare Linux: try docker0 bridge IP (`ip addr show docker0`), fallback `0.0.0.0`
- Override: `CREDENTIAL_PROXY_HOST` env var

**`cleanupOrphans()`:** filter by `name=nanoclaw-` container name prefix. Do NOT kill unrelated containers.

**Agent-runner source sync:** always `fs.cpSync()` agent-runner source into group agent-runner dir (removed cache-check — code changes need to take effect immediately, not on cold container restart).

## Template refactor (`templates/base.md` + `templates/main-extra.md`)

**Intent:** Upstream had duplicative `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` that shared most content. Split into:
- **`templates/base.md`** (~115 lines) — universal persona, rules, capabilities, communication contract. Loaded for ALL groups.
- **`templates/main-extra.md`** (5 lines) — admin-only note that `ops.md` exists with group-management instructions. Loaded ONLY if `isMain=true`.

**Loading in agent-runner (`container/agent-runner/src/index.ts`):**
```typescript
const basePath = '/workspace/templates/base.md';
if (fs.existsSync(basePath)) {
  systemPromptParts.push(fs.readFileSync(basePath, 'utf-8'));
}
if (containerInput.isMain) {
  const mainExtraPath = '/workspace/templates/main-extra.md';
  if (fs.existsSync(mainExtraPath)) {
    systemPromptParts.push(fs.readFileSync(mainExtraPath, 'utf-8'));
  }
}
```

**Host mount:** `templates/` mounted read-only from project root to `/workspace/templates/`.

**What moved where:**
- Old `groups/global/CLAUDE.md` (universal persona) → `templates/base.md`
- Old `groups/main/CLAUDE.md` (main-group-specific) → `templates/main-extra.md` (trimmed to just the admin pointer)
- `groups/global/CLAUDE.md` still exists as USER overlay (personality tweaks beyond base) — a non-main group gets `base.md` + `global/CLAUDE.md`; main gets `base.md` + `main-extra.md` + any main-specific user overlay.

**How to apply on v2:**
1. Create `templates/base.md` — copy content from the fork's current file. Review for v2 tool names (e.g. if v2 renames MCP servers, update tool references in base.md).
2. Create `templates/main-extra.md` — copy from fork.
3. Mount `templates/` ro into container in v2's container-runner.
4. Load base.md + conditional main-extra.md in v2's agent-runner system-prompt assembly.
5. v2 may have a different persona/template system — if so, integrate by inserting base.md into v2's template pipeline at the equivalent point.

## How to apply the whole Stage 3/4

Assemble after credential-isolation (Stage 2) is green:

1. Copy Dockerfile bumps (Node 24, proxy args, gh CLI, google-mcp build step). Keep any v2-specific Dockerfile changes.
2. Copy `build.sh` proxy-inheritance loop. Keep v2's default `CONTAINER_RUNTIME` if v2 has opinions.
3. Apply agent-runner changes: allowedTools fields, slash-command KNOWN set, explicit exit(0), template loader, GOOGLE_SAFE_TOOLS, mcpServers entry.
4. Create `container/.claude/settings.json` if v2 doesn't already.
5. Port container-runner mount logic (templates ro, CLAUDE.md rw, `.env` shadow, host-gateway args, readonly mount args, orphan cleanup filter).
6. Create `templates/base.md` + `main-extra.md`, wire loading.

## Testing checklist

- [ ] `./container/build.sh` succeeds end-to-end
- [ ] Built image has `gh --version` working
- [ ] Built image has `node --version` == 24.x
- [ ] Running a container: `/workspace/templates/base.md` exists and is read-only
- [ ] Running a main-group container: `/workspace/templates/main-extra.md` exists
- [ ] Running a non-main-group container: `main-extra.md` NOT loaded
- [ ] `CLAUDE.md` in main group is writable by agent (agent can `Edit` it)
- [ ] `.env` mount shadows — `cat /.env` in container returns nothing useful
- [ ] `host.docker.internal` resolves inside container (Linux host test)
- [ ] `cleanupOrphans()` leaves non-nanoclaw containers untouched

## Migration risk

- **Medium:** Agent-runner structure. v2 may have substantially rewritten agent-runner (given the restructure). Re-architect the applied changes rather than copying verbatim — port the CONCEPTS (template loading, slash-command gating, allowedTools plumbing), not the exact code.
- **Low:** Dockerfile, build.sh, .claude/settings.json — these are straightforward.
- **Low:** Template content — pure markdown.
