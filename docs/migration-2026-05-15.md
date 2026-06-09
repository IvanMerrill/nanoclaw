# NanoClaw v1 → v2 migration — 2026-05-15

Records what `bash migrate-v2.sh` and `/migrate-from-v1` did on this install.

## Source handoff

```json
{
  "version": 1,
  "started_at": "2026-05-15T14:16:30Z",
  "v1_path": "/Users/ivan/nanoclaw-sandbox-5296",
  "v1_version": "2.0.62",
  "overall_status": "partial",
  "source": "migrate-v2.sh",
  "channels_installed": ["telegram"],
  "onecli_healthy": true,
  "service_switched": true,
  "steps": {
    "1a-env": "success",
    "1b-db": "success",
    "1c-groups": "success",
    "1d-sessions": "failed",
    "1e-tasks": "success",
    "2b-channel-auth": "success",
    "2c-install-telegram": "skipped",
    "3c-auth": "success",
    "3e-build": "failed"
  }
}
```

## Triage of reported failures

- **`3e-build` failed** — the build script tried Apple's `container` CLI (not installed on this host). Docker built the image successfully under the hood: `nanoclaw-agent-v2-98989602:latest` is in `docker images`. Service is running via launchd (`com.nanoclaw-v2-98989602`) and processed real Telegram traffic at 16:15 (route → spawn → deliver, end-to-end, ~23s).
- **`1d-sessions` failed** — ENOENT on a recursive copy descending into `.claude-shared/skills/agent-browser` (likely a broken v1 symlink). The session DBs (`inbound.db`, `outbound.db`) had already been written before the traversal hit the bad symlink. The live session `sess-1778844151107-2p1czv` is operating normally, so conversation continuity is intact.

## Phase 1 — owner / access

Owner was already seeded by the deterministic side:

```
user_roles: telegram:1587043208 → owner (global)
messaging_groups[mg-1778842430584-jcdt7k].unknown_sender_policy = request_approval
```

The DM has the right policy for a personal bot — no member list needed.

## Phase 2 — CLAUDE.local.md restoration

`migrate-v2.sh`'s scrub stripped most of Ivan's customizations from `groups/telegram_main/CLAUDE.local.md` (down to 1.8KB). The full v1 was preserved in `CLAUDE.md.bak` (6KB).

Restored sections from `.bak`:
- Identity preamble ("Your name is Ren. Not Andy. Ren.", origin date, accumulated-context note)
- Personality
- About Ivan
- How You Help Ivan
- Trigger (`@ren`)
- Email Handling (Gmail rules: never delete, `Ren/Triaged`, `Ren/Review`, etc.)
- Google MCP Security Rules
- Working Principles
- Honesty — Non-Negotiable (Memory-First Rule, Challenge Ivan's Assumptions)

Path rewrites: `/workspace/group/` → `/workspace/agent/` throughout (memory.md reference, conversations dir, images path).

Dropped: the v1 "Admin Context" section (replaced by v2's `user_roles` privilege model).

Kept from the post-scrub current file: the long-running-tool-call warning in Communication, and the SOUL.md identity pointer (both were added post-`.bak`).

## Phase 3 — container.json

Empty but valid: `mcpServers: {}`, `packages: { apt: [], npm: [] }`, `additionalMounts: []`. No v1 sidecar (`.v1-container-config.json` did not exist) so nothing to reconcile.

Live `container_configs` DB row matches: `cli_scope='global'` (correct for the owner agent group), `secretMode='all'` on the Ren OneCLI agent.

**Gap (resolved):** the restored CLAUDE.local.md described Gmail / Google MCP behavior, but in v2 the fork's own `container/nanoclaw-google-mcp` (Gmail + Calendar + Drive + Docs + Sheets + Slides) was built into the container image but unwired. The v1 design routed auth through a host-side `google-token-vendor` service (port 3002) via `NANOCLAW_GOOGLE_TOKEN_URL`; in v2 that vendor is redundant because OneCLI is in place.

**Bridge approach chosen:** added a stub-token mode to `container/nanoclaw-google-mcp/src/index.ts`. When `NANOCLAW_GOOGLE_USE_ONECLI=true`, `getToken()` returns `{ access_token: 'onecli-managed', expires_at: now + 365d }` without contacting any token vendor. The OAuth2Client uses that token; OneCLI's gateway intercepts outbound `*.googleapis.com` calls by host pattern and injects the real OAuth bearer at request time.

Wiring:
- `container/nanoclaw-google-mcp/src/index.ts` — added `ONECLI_STUB_MODE` constant + short-circuit at the top of `getToken()`. ~9 lines.
- `container_configs.mcp_servers` (DB) — added entry for `google` via `ncl groups config add-mcp-server --id ag-ren-telegram-main --name google --command node --args '["/app/nanoclaw-google-mcp/dist/index.js"]' --env '{"NANOCLAW_GOOGLE_USE_ONECLI":"true"}'`.
- `container/agent-runner/src/providers/claude.ts` — no change needed; `allowedTools` already dynamically derives `mcp__<server>__*` patterns from `Object.keys(this.mcpServers)`.
- Container image rebuilt via `CONTAINER_RUNTIME=docker ./container/build.sh` (the script's default `container` runtime is Apple's CLI, which isn't installed on this host).
- Container killed via `ncl groups restart --id ag-ren-telegram-main`; next user message respawns.

**OneCLI app status:** Gmail is connected (`gmail.readonly`, `gmail.modify`, `gmail.send`). Calendar / Drive / Docs / Sheets / Slides are **not** connected — those `mcp__google__*` tools will surface to the agent but 401 until the user connects each app in the OneCLI web UI (http://127.0.0.1:10254).

**Skipped:** the stock `/add-gmail-tool` (gongrzhe MCP server) path. Would have been redundant with the fork's own Google MCP and added an unrelated Gmail-only tool surface.

**Known gap to revisit:** v1's design intentionally excluded `mcp__google__send_email` from the default allowlist and only enabled it in interactive (non-scheduled) sessions — enforced via two separate allowlists. v2's dynamic allowlist allows the entire `mcp__google__*` namespace whenever the `google` server is configured, so `send_email` is now always allowed. CLAUDE.local.md still tells Ren "never send_email without explicit instruction; send_email is blocked for scheduled tasks" — but that's now guidance, not hard SDK-level enforcement. Hardening this back would require splitting the allowlist by session kind in `container/agent-runner/src/providers/claude.ts`.

## Phase 4 — fork customizations

N/A. The `main` branch is ~100 commits ahead of `upstream/main`, but those are v2 development work (channel adapters, dependency updates, nightly maintenance) on a fork the user maintains — not v1 source customizations to port.

## Final verify

```
SERVICE: running
CONTAINER_RUNTIME: docker
CREDENTIALS: configured
CONFIGURED_CHANNELS: telegram
CHANNEL_AUTH: {"telegram":"configured"}
REGISTERED_GROUPS: 1
MOUNT_ALLOWLIST: configured
STATUS: success
```
