# 01 — Channels + Google Workspace

Three interconnected pieces: **Google MCP server** (container-side, 30 tools), **Gmail channel** (host-side poller + reply flow), **Telegram channel** (host-side grammy client). They share the credential isolation layer in `02-credential-isolation.md` (Google token vendor; credential proxy is not channel-specific but affects agent-runner wiring).

## Google MCP Server (`container/nanoclaw-google-mcp/`)

**Intent:** Unified MCP server replacing what upstream used to do with separate Gmail/Calendar MCPs. Exposes Gmail, Drive, Calendar, Docs, Sheets, Slides, plus a generic `read_document` tool for PDFs/DOCX/XLSX/PPTX extraction. Runs inside the agent container, fetches access tokens from the host-side token vendor (not from the container's env or files).

**Files:** Entire `container/nanoclaw-google-mcp/` directory — keep as one unit. Copy wholesale from the fork into the v2 worktree at the same relative path.

**30 tools exposed** (exact names — used in `agent-runner` allowlist):
- Gmail (8): `search_emails`, `read_email`, `modify_email`, `batch_modify_emails`, `list_email_labels`, `get_or_create_label`, `draft_email`, `download_attachment`
- Calendar (5): `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`
- Drive (6): `list_drive_files`, `export_drive_file`, `upload_drive_file`, `update_drive_file_content`, `create_drive_folder`, `move_drive_file`
- Docs (3): `get_doc_metadata`, `create_doc`, `update_doc`
- Sheets (4): `list_sheets`, `read_sheet_range`, `create_spreadsheet`, `write_sheet_range`
- Slides (2): `get_presentation_metadata`, `create_presentation`
- Documents (1): `read_document` (local files only, in `/workspace/group/attachments/` or `/workspace/group/drive-exports/`)
- **Intentionally excluded from safe tools:** `send_email` — only interactive (non-scheduled) messages may send email; enforced separately in `src/ipc.ts` and `container/agent-runner/src/index.ts` allowlist.

**How to apply on v2:**

1. Copy the directory as-is:
   ```bash
   cp -r <fork>/container/nanoclaw-google-mcp "$WORKTREE/container/"
   ```
2. Ensure `container/Dockerfile` builds it (covered in `07-container-and-templates.md`):
   ```dockerfile
   COPY nanoclaw-google-mcp ./nanoclaw-google-mcp
   RUN cd nanoclaw-google-mcp && npm ci && npm run build
   ```
3. Wire into agent-runner's MCP servers config. In the fork: `container/agent-runner/src/index.ts` defines `GOOGLE_SAFE_TOOLS` (~30 entries, all prefixed `mcp__google__*`) and adds an entry to `mcpServers`:
   ```typescript
   google: {
     command: 'node',
     args: ['/app/nanoclaw-google-mcp/dist/index.js'],
     env: {
       NANOCLAW_GOOGLE_TOKEN_URL: process.env.NANOCLAW_GOOGLE_TOKEN_URL ?? '',
     },
   }
   ```
   On v2, find the equivalent mcpServers config point and add this. The env var is passed from the host (`src/container-runner.ts` equivalent) which computes the token vendor URL.
4. `DEFAULT_ALLOWED_TOOLS` in agent-runner must include `GOOGLE_SAFE_TOOLS`. Do NOT include `mcp__google__send_email` in the default; only include it in the interactive-message path.

**Auth model:**
- OAuth creds live on host at `~/.nanoclaw-google-mcp/oauth-{readonly,readwrite}.json` (client ID/secret) and `~/.nanoclaw-google-mcp/{readonly,readwrite}-credentials.json` (token objects).
- Container MCP reads `NANOCLAW_GOOGLE_TOKEN_URL` env, POSTs `{scope: "readonly"|"readwrite"}` to it, gets back `{access_token, expires_at}`. Refreshes in-memory with 30s buffer.
- Initial auth: `cd container/nanoclaw-google-mcp && npm run auth:readonly && npm run auth:readwrite` on host, opens browser, captures callback at `http://localhost:3000/callback`, writes creds to `~/.nanoclaw-google-mcp/`.

**Dependencies** (pinned in `container/nanoclaw-google-mcp/package.json`): `@modelcontextprotocol/sdk ^1.12.1`, `googleapis ^171.4.0`, `google-auth-library ^10.6.2`, `mammoth ^1.12.0`, `pdfjs-dist ^5.5.207`, `xlsx 0.18.5`, `nodemailer ^8.0.4`, `zod ^4.0.0`.

---

## Gmail channel (`src/channels/gmail.ts`)

**Intent:** Host-side poller that surfaces unread primary-inbox Gmail messages to Ren's main group, and lets Ren reply via RFC 2822 threaded sends. Separate from the container-side MCP tools (which let Ren actively operate on mail). Together they give "Gmail as a channel" (push-style notifications) AND "Gmail as a tool" (on-demand search/modify).

**Files to create on v2:** `<v2-channels-dir>/gmail.ts`, `<v2-channels-dir>/gmail.test.ts`. The v2 channel interface will differ — read v2's existing channel (e.g. its Telegram or Slack channel) to see the factory/register pattern, then adapt.

**External integrations:**
- `googleapis` v171.4.0: `gmail_v1.Gmail` client
- `google-auth-library` v10.6.2: `OAuth2Client` for credential management
- Gmail API endpoints:
  - `users.messages.list` with query `is:unread category:primary`
  - `users.threads.get` (metadata format: `From`, `Subject`, `Message-ID`)
  - `users.messages.get` (full format for body extraction)
  - `users.messages.modify` (remove `UNREAD` label after delivery)
  - `users.messages.send` (raw RFC 2822, base64url-encoded)

**Behavior that must be preserved (non-obvious logic):**
1. **Recursive multipart MIME extraction** — `extractTextBody()` walks the part tree, prefers `text/plain` over `text/html`, handles nested multipart.
2. **Body truncation at 8000 chars** with footnote: `[Email body truncated. Use Gmail MCP tools to read the full message.]` — so Ren knows to switch to MCP tools for long emails.
3. **Thread metadata caching with Gmail-API recovery** — in-memory map of `threadId → {from, subject, messageId}` populated on ingest. If Ren is restarted and replies to a thread whose metadata was lost, recover via `threads.get(metadata)` on first reply attempt.
4. **In-Reply-To + References headers** on replies so Gmail threads correctly on the recipient's side.
5. **Base64-URL encoding for raw send:** replace `+` → `-`, `/` → `_`, strip trailing `=`.
6. **Exponential backoff on poll failures:** `2^consecutiveErrors * 60s`, capped at 30 min; reset counter on any successful poll.
7. **Processed-IDs memory bound:** cap `processedIds` set at 5000; slide to 2500 on overflow.
8. **Self-message filter:** skip any email whose `From` equals `this.userEmail` (avoid echoing Ren's own replies).
9. **Main-group delivery only:** call `opts.registeredGroups()` and deliver only to the group with `isMain === true`.
10. **Poll interval:** 60s.

**Config:**
- Reads OAuth from `~/.nanoclaw-google-mcp/oauth-readonly.json` and `~/.nanoclaw-google-mcp/readonly-credentials.json` (shared with Google MCP readonly scope).
- Persists refreshed tokens via `oauth2Client.on('tokens', ...)` to disk — so the token cache on the host stays fresh.
- **No env vars.** Pure file-based credentials.

**Dependencies between files:** imports `registerChannel`, `ChannelOpts` from the host channel registry. Calls `opts.onChatMetadata()` to register chats for discovery, `opts.onMessage()` to deliver to the main group.

---

## Telegram channel (`src/channels/telegram.ts`)

**Intent:** Primary channel. grammy-based long-poll bot, delivers text + rich media to registered groups/DMs, handles Markdown-v1 with plain-text fallback, supports built-in `/chatid` and `/ping`, proxies other `/commands` through to Ren.

**Files to create on v2:** `<v2-channels-dir>/telegram.ts` + test. v2 has its own Telegram implementation (with new pairing-code flow); **do NOT adopt v2's implementation** — port the fork's custom behavior onto v2's channel interface pattern.

**External integrations:**
- `grammy ^1.39.3`: `Bot` with long-poll, `sendMessage` (Markdown), `getFile` (download), `sendChatAction` (typing)
- `https-proxy-agent ^9.0`: respects `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`
- File extraction: fork's own `extractText()` from `src/file-extract.ts` (uses `mammoth` and `pdftotext` CLI)

**Behavior that must be preserved (non-obvious logic):**
1. **@mention → trigger translation.** Telegram's `@bot_username` mentions won't match the configured `TRIGGER_PATTERN`. On incoming message, detect the @mention at start, replace once with `@{ASSISTANT_NAME}` so the trigger pattern matches. Only once per message. Critical for how users invoke Ren in groups.
2. **Markdown-v1 compatibility.** Claude's output naturally matches Telegram Markdown v1 (`*bold*`, `_italic_`, `` `code` ``, code fences, `[links](url)`). Wrap `sendMessage` in try/catch; on Markdown parse error, resend as plain text.
3. **Media handling:**
   - Photos: download highest-resolution variant (last in array) → save to `{groupDir}/images/tg_{messageId}.{ext}`. Pass container path `/workspace/group/images/tg_{messageId}.{ext}` to Ren.
   - Documents: sanitize filename, save to `{groupDir}/files/tg_{messageId}_{sanitized_name}`, run `extractText()` on it, format with `formatFileMessage()` so Ren receives `[File: path]\n--- file contents ---\n{text}\n--- end file contents ---`.
4. **Non-text placeholders:** stickers → `[Sticker {emoji}]`, videos → `[Video]`, voice → `[Voice message]`, audio → `[Audio]`, locations → `[Location]`, contacts → `[Contact]`.
5. **Built-in commands:** `/chatid` (echoes current chat's JID for registering a new group), `/ping` (liveness). Other `/commands` pass through to the main handler so Ren can process them.
6. **Unregistered chat suppression:** messages from unregistered groups/DMs only call `opts.onChatMetadata()` (for discovery); do NOT trigger the message loop via `opts.onMessage()`.
7. **Typing indicator:** `setTyping(chatJid, isTyping)` calls `sendChatAction` with `composing` or `paused`.
8. **Poll initialization blocks `connect()`:** the bot's `connect()` promise doesn't resolve until polling actually starts (use grammy's `onStart` callback).
9. **On successful start:** log bot username + `/chatid` instructions to console — helps first-time setup.
10. **Per-group trigger pattern:** (added in the fork, see `03-session-commands.md`) — when extracting commands or checking trigger, use the group's `group.trigger` not the global `TRIGGER_PATTERN`. Threaded through via `getTriggerPattern(group.trigger)`.

**Config/env:**
- `TELEGRAM_BOT_TOKEN` — loaded via `readEnvFile(['TELEGRAM_BOT_TOKEN'])` (NOT `process.env`, to preserve credential isolation). Documented in `.env.example`.
- Group paths: resolve via `resolveGroupFolderPath(group.folder)` (the safe-path util described in `04-router-and-security.md`).

**Dependencies between files:**
- `src/config.ts` equivalent → `ASSISTANT_NAME`, `TRIGGER_PATTERN`
- `src/env.ts` → `readEnvFile()`
- `src/file-extract.ts` → `sanitizeFilename`, `extractText`, `formatFileMessage`
- `src/group-folder.ts` → `resolveGroupFolderPath`

---

## Channel registration (`src/channels/index.ts`)

**Intent:** Barrel file that imports channel modules to trigger their `registerChannel()` side effects at startup.

**Files:** `<v2-channels-dir>/index.ts` (or equivalent — v2 may auto-discover channels via a different pattern; read v2's code first).

**Fork's current contents (minus whatsapp):**
```typescript
import './gmail.js';
import './telegram.js';
// whatsapp intentionally disabled — user confirmed Gmail + Telegram only
```

Do NOT port `whatsapp.ts`, `whatsapp-auth.ts`, `setup/whatsapp-auth.ts`, or any baileys-related code. Omit `@whiskeysockets/baileys`, `qrcode`, `qrcode-terminal` from `package.json` if v2 doesn't already include them.

---

## Testing checklist for Stage 3

After reimplementing on v2:
- [ ] `TELEGRAM_BOT_TOKEN` loads from `.env` (not process.env)
- [ ] Bot logs on start, `/chatid` works in an unregistered DM
- [ ] @-mentioning the bot in a registered group triggers Ren
- [ ] Sending a PDF/DOCX attachment extracts text into the message
- [ ] Gmail poller finds an unread primary email and surfaces it to main group
- [ ] Replying from main group via Ren sends a threaded Gmail reply (check In-Reply-To in Gmail web)
- [ ] Google MCP `search_emails` works from inside container (token vendor path)
- [ ] `send_email` is NOT in the default container tool allowlist
