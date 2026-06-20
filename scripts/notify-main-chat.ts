/**
 * scripts/notify-main-chat.ts — host-side notification into the v2 message flow.
 *
 * Usage:
 *   pnpm exec tsx scripts/notify-main-chat.ts "<message text>"
 *   echo "<message text>" | pnpm exec tsx scripts/notify-main-chat.ts
 *
 * Replaces the dead v1 IPC drop path (data/ipc/.../messages/*.json), which
 * nothing watches in v2. This resolves the active Telegram session from the
 * central DB and writes a `messages_out` row into that session's outbound.db,
 * exactly as writeOutboundDirect() does in src/session-manager.ts. The host's
 * delivery sweep (60s, all status='active' sessions — regardless of whether a
 * container is running) picks it up and delivers through the Telegram adapter.
 *
 * Why a standalone script and not an import of src/session-manager.ts: this
 * runs from launchd with a minimal environment and must not pull in host
 * module init. It reads the canonical channel_type / platform_id straight
 * from the DB so there is no format drift.
 *
 * Env overrides (for tests / non-default installs):
 *   NANOCLAW_ROOT               — project root (default: this script's ../).
 *   NANOCLAW_NOTIFY_PLATFORM_ID — pin the target chat when more than one
 *                                 active Telegram session exists.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const ROOT = process.env.NANOCLAW_ROOT ?? path.resolve(import.meta.dirname, '..');
const CENTRAL_DB = path.join(ROOT, 'data', 'v2.db');

function readMessage(): string {
  const arg = process.argv[2];
  if (arg !== undefined && arg !== '') return arg;
  // Fall back to stdin so callers can pipe multi-line summaries.
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

const message = readMessage();
if (!message) {
  console.error('notify-main-chat: no message text (pass as arg or via stdin)');
  process.exit(2);
}

if (!existsSync(CENTRAL_DB)) {
  console.error(`notify-main-chat: central DB not found at ${CENTRAL_DB}`);
  process.exit(1);
}

interface Target {
  session_id: string;
  agent_group_id: string;
  channel_type: string;
  platform_id: string;
}

const central = new Database(CENTRAL_DB, { readonly: true });
let target: Target | undefined;
try {
  const pinned = process.env.NANOCLAW_NOTIFY_PLATFORM_ID;
  const rows = central
    .prepare(
      `SELECT s.id AS session_id, s.agent_group_id AS agent_group_id,
              m.channel_type AS channel_type, m.platform_id AS platform_id
         FROM sessions s
         JOIN messaging_groups m ON m.id = s.messaging_group_id
        WHERE s.status = 'active' AND m.channel_type = 'telegram'
          ${pinned ? 'AND m.platform_id = ?' : ''}
        ORDER BY s.created_at DESC`,
    )
    .all(...(pinned ? [pinned] : [])) as Target[];

  if (rows.length === 0) {
    console.error('notify-main-chat: no active Telegram session found — nothing to notify');
    process.exit(1);
  }
  if (rows.length > 1 && !pinned) {
    console.error(
      `notify-main-chat: ${rows.length} active Telegram sessions — set NANOCLAW_NOTIFY_PLATFORM_ID to disambiguate`,
    );
    process.exit(1);
  }
  target = rows[0];
} finally {
  central.close();
}

const outboundPath = path.join(
  ROOT,
  'data',
  'v2-sessions',
  target.agent_group_id,
  target.session_id,
  'outbound.db',
);
if (!existsSync(outboundPath)) {
  console.error(`notify-main-chat: outbound.db not found at ${outboundPath}`);
  process.exit(1);
}

// Mirror writeOutboundDirect() in src/session-manager.ts: host uses even seq
// (MAX(seq)+2), kind 'chat', content as JSON { text }. Open RW, write, close —
// the cross-mount visibility invariant requires the connection to be released.
const id = `notify-${Date.now()}-${process.pid}`;
const content = JSON.stringify({ text: message });

const out = new Database(outboundPath);
try {
  out.prepare(
    `INSERT OR IGNORE INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, thread_id, content)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), 'chat', ?, ?, NULL, ?)`,
  ).run(id, target.platform_id, target.channel_type, content);
} finally {
  out.close();
}

console.log(`notify-main-chat: queued ${id} for ${target.channel_type}/${target.platform_id}`);
