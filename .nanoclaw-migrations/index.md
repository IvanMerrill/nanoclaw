# NanoClaw Migration Guide — main → v2

Generated: 2026-04-15T20:20:58Z
Base (merge-base HEAD..upstream/v2): `934f063aff5c30e7b49ce58b53b41901d3472a3e`
HEAD at generation: `64652ab40c965645db4ac3be7972425ae454148c`
Upstream target: `upstream/v2` @ `03684d33e28d4a9872ed0ac40d03a79d5a6f7b37`

## Target architecture

**Re-architect onto v2's new `src/` layout.** v2 preserves the old pre-v2 code under `src/v1/`, but the user has chosen to adopt v2's new architecture rather than pinning to `src/v1/`. That means every customization below should be reimplemented against v2's patterns, not copy-pasted to old paths.

Before touching code, a future Claude session MUST read v2's top-level structure:
- `src/` (new architecture — channels, routing, agent invocation)
- `container/` (agent-runner patterns — may have changed)
- `.claude/skills/` (skill layout — v2 added `add-*-v2` variants for several channels)
- `docs/REQUIREMENTS.md` and any `docs/SPEC-*.md` on v2 for design intent

## User decisions (from interactive Extract phase)

1. **WhatsApp channel: DROP.** The fork has `src/channels/whatsapp.ts`, `src/whatsapp-auth.ts`, `setup/whatsapp-auth.ts`, but the import in `src/channels/index.ts:15` is commented out. User confirmed they only use Gmail + Telegram. Do NOT port WhatsApp code during upgrade.
2. **Channels on v2: PORT AS-IS.** Do NOT adopt v2's new Telegram pairing-code flow or `add-gchat-v2` (Google Chat, unrelated to Gmail). Keep the fork's custom Gmail + Telegram channels.
3. **DB schema: PRESERVE allowed_tools column.** The `scheduled_tasks` table has a custom `allowed_tools` TEXT column (JSON array or NULL). Carry this forward via a v2-side DB migration so existing scheduled tasks keep their tool restrictions.

## Applied skills to reapply

All three of these were merged from pre-v2 branches (`qwibitai/skill/*`). Their source files likely touch paths that v2 has restructured. Do NOT blindly `git merge` them into v2 — **re-implement from intent**. If the corresponding skill branch has been rebased onto v2 by upstream, prefer that over recreating.

| Skill | Original merge commit | Upstream branch | User customized? |
|---|---|---|---|
| `add-compact` | `925c12f` | `skill/compact` | **Yes** — threaded per-group trigger pattern through session commands (see `03-session-commands.md`) |
| `convert-to-apple-container` | `63d5c41` | `skill/apple-container` | No — used as-is |
| `use-native-credential-proxy` | `97aadc4` | `skill/native-credential-proxy` | No — used as-is, BUT user deeply extended it with Google token vendor; treat the whole credential-isolation story as custom (see `02-credential-isolation.md`) |

**Custom integrations (never came from upstream skills):**
- **Gmail channel** (merge `9fa982e`) — see `01-channels-and-google.md`
- **Telegram channel** (merge `df014ce`) — see `01-channels-and-google.md`

Operational skills installed in `.claude/skills/` (e.g. `setup`, `debug`, `customize`, `update-nanoclaw`, `migrate-nanoclaw`) are shipped by upstream as instruction-only skills on `main`/`v2`. Do not treat as customizations. The one exception:

- **`.claude/skills/setup/SKILL.md`** — user added `rm -rf node_modules && npm install && npm run build` after channel skill merges to avoid native-binding conflicts (baileys, grammy). If v2's setup differs, reapply the intent only.

## Skill interactions

Documented in the feature sections, but the main ones:

- **Credential proxy + Google token vendor** — both host microservices, bound to different ports. If v2 ships its own credential-proxy story (e.g. native OneCLI integration), resolve BEFORE implementing this section. See `02-credential-isolation.md`.
- **Session commands + per-group trigger** — the user's trigger-pattern rework (commit `64652ab` and earlier) touches `src/index.ts` at the same call sites as `add-compact`'s session-command handling. Apply `add-compact` first, then thread `group.trigger` through.
- **Nightly automation + DB migrations** — `auto-update-deps.sh` restarts Ren after upgrades. If the `allowed_tools` schema migration lives in host startup, the nightly restart path exercises it; test. See `06-task-scheduler.md`.

## Migration plan (staging)

v2 is a 217-file / 108-commit rewrite ahead of merge-base. Staged migration, validating at each stage:

### Stage 1 — Foundation (core + deps)
1. Skills reapplied or reimplemented as needed (Apple Container, Compact w/ per-group trigger, native credential proxy stubs if v2 doesn't ship equivalent)
2. Root config: `package.json` runtime deps (baileys intentionally dropped), TS 6 bump, vitest coverage — see `08-deps-config-misc.md`
3. Container: Node 24 base image, proxy build args, `gh` CLI — see `07-container-and-templates.md`

### Stage 2 — Credential isolation
4. Credential proxy (`src/credential-proxy.ts` equivalent on v2 layout)
5. Google token vendor (`src/google-token-vendor.ts` equivalent)
6. Env reading without `process.env` mutation (`src/env.ts` equivalent)
— see `02-credential-isolation.md`
— **Validate:** containers can reach Anthropic via proxy; Google MCP receives tokens.

### Stage 3 — Google + channels
7. Google MCP server (`container/nanoclaw-google-mcp/`) — copy whole-cloth, adjust any wiring to v2's mcpServers config in agent-runner
8. Gmail channel on v2 pattern
9. Telegram channel on v2 pattern
— see `01-channels-and-google.md`
— **Validate:** poll Gmail, receive Telegram message, send reply.

### Stage 4 — Safety + commands
10. Router redactions, catbox strip, `<internal>` tag strip — see `04-router-and-security.md`
11. IPC hardening (rate limits, size caps, spawn cap, mount allowlist) — see `04-router-and-security.md`
12. Session commands (`/compact` from add-compact, `/clear` archival) — see `03-session-commands.md`
— **Validate:** secret in test message gets redacted; `/clear` archives to `conversations/`.

### Stage 5 — Scheduler + automation
13. Task scheduler DST fix, `allowed_tools` DB migration, error notifications, `spawn_agent` — see `05-task-scheduler.md`
14. Template refactor (base.md + main-extra.md) — see `07-container-and-templates.md`
15. Nightly automation scripts — see `06-nightly-automation.md`
— **Validate:** existing scheduled tasks load and run; run `auto-upstream-sync.sh --dry-run`.

### Stage 6 — Live test
16. Live test via the standard skill flow (symlink `store/`, `data/`, `groups/`, `.env` into worktree, `npm run dev`, send real Telegram message).

## File index

| Section | File |
|---|---|
| Channels + Google MCP | `01-channels-and-google.md` |
| Credential isolation (proxy + vendor) | `02-credential-isolation.md` |
| Session commands (/compact, /clear) | `03-session-commands.md` |
| Router + security (redact, links, IPC hardening) | `04-router-and-security.md` |
| Task scheduler (DST, allowed_tools, spawn_agent) | `05-task-scheduler.md` |
| Nightly automation scripts | `06-nightly-automation.md` |
| Container + template refactor | `07-container-and-templates.md` |
| Dependencies, config, misc | `08-deps-config-misc.md` |

## Data preserved as-is (never touched by migration)

- `groups/` — per-group CLAUDE.md memory (todos, reminders, persona)
- `store/auth/` — Baileys/WhatsApp session creds (kept even though WA is disabled — cheap)
- `store/messages.db` — message history
- `store/nanoclaw.db` — host-side state
- `nanoclaw.db` — registered groups, main chat pointer, scheduled tasks (needs `allowed_tools` column re-added on v2 schema)
- `data/ipc/`, `data/sessions/`, `data/env/`, `data/ca-cert/` — runtime state
- `.env` — all credentials (ANTHROPIC_API_KEY / OAuth, TELEGRAM_BOT_TOKEN, proxy vars)
- `~/.nanoclaw-google-mcp/` — OAuth JSON + token caches for Google readonly/readwrite scopes
- `~/.config/nanoclaw/mount-allowlist.json` — mount security allowlist

## Rollback

Backup branch + tag created in Phase 2 step 2.1:
```
git branch backup/pre-migrate-<hash>-<timestamp>
git tag pre-migrate-<hash>-<timestamp>
```

If upgrade fails: `git reset --hard <tag>`, then `launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist`. Data dirs are untouched so all reminders/auth/history are preserved.
