# 08 — Dependencies, Config, and Miscellaneous

Catch-all for root-level config changes and small customizations that didn't fit elsewhere.

## `package.json` (root)

**Runtime deps added in fork (after filtering out ones that came with skills):**
- `googleapis ^171.4.0` — Gmail channel, Google token vendor
- `google-auth-library ^10.6.2` — OAuth2Client for token refresh
- `grammy ^1.39.3` — Telegram bot framework
- `https-proxy-agent ^9.0.0` — Proxy support for outbound HTTP
- `mammoth ^1.12.0` — DOCX text extraction (used in `file-extract.ts`)
- `undici ^7.24.7` — HTTP client (restored from an upstream merge that accidentally dropped it, commit `722f93f`)
- `yaml ^2.8.2` — YAML parsing (used for config-examples)
- `zod ^4.3.6` — Schema validation

**Runtime deps INTENTIONALLY OMITTED (do not add even if fork's package.json has them):**
- `@whiskeysockets/baileys` — WhatsApp is dropped (user confirmed Telegram + Gmail only)
- `qrcode` — only used by WhatsApp auth
- `qrcode-terminal` — only used by WhatsApp auth
- `pino` / `pino-pretty` — fork removed direct dependency (commits `a674f5f`, `fa4917b`); only a Baileys-compat shim remains. If WhatsApp is dropped, these are unnecessary.

**Runtime version bump:**
- `@onecli-sh/sdk 0.2.0 → 0.3.1` — whether this is still needed depends on whether OneCLI is used at all post-migration (see `02-credential-isolation.md` — user uses native credential proxy).

**Dev deps bumped:**
- `typescript 5.7 → 6.0.2` — major bump; v2 may have its own TS version preference, align with v2 unless fork needs something specific
- `@types/node 22 → 25`
- `eslint 9 → 10`, `@eslint/js 9 → 10`, `globals 15 → 17`
- `@vitest/coverage-v8 ^4.0.18` — new, for coverage reporting

**Recommendation:** When reimplementing on v2, start from v2's `package.json`, then merge in the fork's deltas (`googleapis`, `google-auth-library`, `grammy`, `https-proxy-agent`, `mammoth`, `undici`, `yaml`, `zod`). Keep v2's dev-dep versions unless a fork feature requires a newer one.

## `container/agent-runner/package.json`

**Changes:** tracking upstream-ish. No notable customizations beyond SDK version bumps that the nightly script handles. Merge v2's version, let nightly job update.

## `container/nanoclaw-google-mcp/package.json`

Entirely custom to fork. Copy as-is — see `01-channels-and-google.md`.

## `vitest.config.ts`

**Fork addition:** coverage configuration block
```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'json-summary'],
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.test.ts'],
}
```

**How to apply:** if v2 has its own vitest config with coverage differently configured, prefer v2's. If v2 has no coverage config, add this block.

## `vitest.skills.config.ts`, `tsconfig.json`, `eslint.config.js`

Not modified in fork — use v2's versions.

## `CLAUDE.md` (root)

Not modified in fork — use v2's version.

## `.env.example` additions

```
# Telegram bot token (required for Telegram channel)
TELEGRAM_BOT_TOKEN=

# true if Ren has a dedicated bot/phone number; false on a shared number
ASSISTANT_HAS_OWN_NUMBER=
```

## `.gitignore` additions

```
groups/
credentials.json
.worktrees/
nanoclaw.pid
```

`groups/` was previously tracked selectively (`!groups/main/CLAUDE.md`); fork broadened to ignore the whole directory to avoid accidental personal data commits. Align with v2's current `.gitignore`; if v2 already ignores `groups/`, the others are likely acceptable additions.

## `.claude/skills/setup/SKILL.md`

**Single change:** added a cleanup step after channel skill merges:
```
rm -rf node_modules
npm install && npm run build
```

**Intent:** Channel skills (WhatsApp, Telegram, Slack, etc.) bring transitive deps with C++ bindings. Merging multiple can leave `node_modules` in a broken state. A clean reinstall is more reliable than `npm install` alone.

**How to apply:** If v2's `setup` skill differs, only apply the *intent* — insert a clean-install step at the equivalent "after all channel skills applied" point. Don't blindly copy text.

## `CHANGELOG.md`

Fork accumulated entries tracking automated dependency updates and feature work. On v2, **do not port**. Restart the changelog from v2's position; the fork's CHANGELOG represents pre-v2 history.

## Misc small customizations

- **Per-group trigger pattern** (covered in `03-session-commands.md`) — three call sites in `src/index.ts` use `getTriggerPattern(group.trigger)` instead of hardcoded `TRIGGER_PATTERN`.
- **Sender allowlist 30s cache** (covered in `04-router-and-security.md`).
- **DB message 10KB truncation** (covered in `04-router-and-security.md`).
- **Group queue close-sentinel logging** — `src/group-queue.ts` adds log lines when `closeStdin()` skips (no active container) and when close sentinel is written. Debuggability only, safe to reapply by finding v2's equivalent function and adding similar logs.

## Testing checklist (general post-migration sanity)

- [ ] `npm install` succeeds with no version conflicts
- [ ] `npm run build` succeeds (TypeScript compile clean)
- [ ] `npm test` — all tests pass (expect new tests for ported features)
- [ ] `npm run test:coverage` generates v8 coverage report
- [ ] `./container/build.sh` succeeds
- [ ] `.env.example` has `TELEGRAM_BOT_TOKEN` and `ASSISTANT_HAS_OWN_NUMBER`
- [ ] `groups/` is gitignored (try `touch groups/testfile && git status` — should not show)
- [ ] `/setup` skill includes the clean-install step

## Migration risk

- **Low:** All of this is mechanical. Apply after the meaty sections (1–7) are green.
- **Worth watching:** TypeScript 6 compatibility. If the fork's code relies on TS-6-only features and v2 pins TS 5.x, there may be compile errors. Downgrade syntax or wait for v2 to bump.
