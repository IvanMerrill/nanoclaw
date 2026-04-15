/**
 * Unit tests for conversation archiving logic in index.ts.
 *
 * Run after building: npm run build && npm test
 *
 * Tests cover:
 * 1. parseTranscript — correct parsing of JSONL transcript lines
 * 2. sanitizeFilename — output is lowercase alphanumeric with hyphens, max 50 chars
 * 3. generateFallbackName — output matches conversation-HHMM pattern
 * 4. formatTranscriptMarkdown — output contains expected sections
 * 5. archiveCurrentSession — UUID validation, missing JSONL, successful archive, empty transcript
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseTranscript,
  sanitizeFilename,
  generateFallbackName,
  formatTranscriptMarkdown,
  archiveCurrentSession,
  type ParsedMessage,
} from './index.js';

// ---------------------------------------------------------------------------
// parseTranscript
// ---------------------------------------------------------------------------

test('parseTranscript: parses user message', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { content: 'Hello there' },
  });
  const messages = parseTranscript(line);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Hello there');
});

test('parseTranscript: parses assistant message with text parts', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    },
  });
  const messages = parseTranscript(line);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'Hello world');
});

test('parseTranscript: skips non-message lines', () => {
  const content = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'user', message: { content: 'Hi' } }),
    'invalid json {{{{',
    '',
  ].join('\n');
  const messages = parseTranscript(content);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Hi');
});

test('parseTranscript: returns empty array for empty input', () => {
  assert.deepEqual(parseTranscript(''), []);
});

test('parseTranscript: skips messages with empty content', () => {
  const line = JSON.stringify({
    type: 'user',
    message: { content: '' },
  });
  assert.deepEqual(parseTranscript(line), []);
});

// ---------------------------------------------------------------------------
// sanitizeFilename
// ---------------------------------------------------------------------------

test('sanitizeFilename: lowercases and replaces spaces with hyphens', () => {
  assert.equal(sanitizeFilename('Hello World'), 'hello-world');
});

test('sanitizeFilename: removes special characters', () => {
  assert.equal(sanitizeFilename('Fix bug: auth/login'), 'fix-bug-auth-login');
});

test('sanitizeFilename: trims leading and trailing hyphens', () => {
  assert.equal(sanitizeFilename('---hello---'), 'hello');
});

test('sanitizeFilename: truncates to 50 characters', () => {
  const long = 'a'.repeat(60);
  assert.equal(sanitizeFilename(long).length, 50);
});

test('sanitizeFilename: collapses multiple separators', () => {
  assert.equal(sanitizeFilename('hello   world'), 'hello-world');
});

// ---------------------------------------------------------------------------
// generateFallbackName
// ---------------------------------------------------------------------------

test('generateFallbackName: matches conversation-HHMM pattern', () => {
  const name = generateFallbackName();
  assert.match(name, /^conversation-\d{4}$/);
});

test('generateFallbackName: hours and minutes are zero-padded', () => {
  const name = generateFallbackName();
  const timePart = name.slice(-4);
  assert.match(timePart, /^\d{4}$/);
  const hours = parseInt(timePart.slice(0, 2), 10);
  const minutes = parseInt(timePart.slice(2, 4), 10);
  assert.ok(hours >= 0 && hours <= 23, `hours out of range: ${hours}`);
  assert.ok(minutes >= 0 && minutes <= 59, `minutes out of range: ${minutes}`);
});

// ---------------------------------------------------------------------------
// formatTranscriptMarkdown
// ---------------------------------------------------------------------------

test('formatTranscriptMarkdown: includes title', () => {
  const messages: ParsedMessage[] = [{ role: 'user', content: 'Hi' }];
  const md = formatTranscriptMarkdown(messages, 'My Title');
  assert.ok(md.includes('# My Title'), 'Should include title as H1');
});

test('formatTranscriptMarkdown: uses Conversation as default title', () => {
  const messages: ParsedMessage[] = [{ role: 'user', content: 'Hi' }];
  const md = formatTranscriptMarkdown(messages);
  assert.ok(md.includes('# Conversation'), 'Should default to Conversation');
});

test('formatTranscriptMarkdown: uses custom assistant name', () => {
  const messages: ParsedMessage[] = [{ role: 'assistant', content: 'Hello' }];
  const md = formatTranscriptMarkdown(messages, null, 'Ren');
  assert.ok(md.includes('**Ren**:'), 'Should use custom assistant name');
});

test('formatTranscriptMarkdown: uses Assistant as default name', () => {
  const messages: ParsedMessage[] = [{ role: 'assistant', content: 'Hello' }];
  const md = formatTranscriptMarkdown(messages);
  assert.ok(md.includes('**Assistant**:'), 'Should default to Assistant');
});

test('formatTranscriptMarkdown: truncates long content', () => {
  const longContent = 'x'.repeat(3000);
  const messages: ParsedMessage[] = [{ role: 'user', content: longContent }];
  const md = formatTranscriptMarkdown(messages);
  assert.ok(md.includes('...'), 'Should truncate and add ellipsis');
});

test('formatTranscriptMarkdown: includes Archived timestamp line', () => {
  const messages: ParsedMessage[] = [{ role: 'user', content: 'Hi' }];
  const md = formatTranscriptMarkdown(messages);
  assert.ok(md.includes('Archived:'), 'Should include Archived timestamp');
});

// ---------------------------------------------------------------------------
// archiveCurrentSession
// ---------------------------------------------------------------------------

/**
 * Helper: creates a temp directory with a fake JSONL file and conversations/ dir.
 */
function setupTestEnvironment(messages: Array<{ type: string; content: string }>): {
  tmpDir: string;
  sessionId: string;
  conversationsDir: string;
  transcriptPath: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
  const sessionId = '00000000-0000-0000-0000-000000000001';

  const lines = messages.map((m) => {
    if (m.type === 'user') {
      return JSON.stringify({ type: 'user', message: { content: m.content } });
    }
    return JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: m.content }] },
    });
  });

  const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, lines.join('\n'));

  const conversationsDir = path.join(tmpDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  return { tmpDir, sessionId, conversationsDir, transcriptPath };
}

test('archiveCurrentSession: skips when sessionId is undefined', () => {
  // Should not throw
  archiveCurrentSession(undefined);
});

test('archiveCurrentSession: skips when sessionId is not a UUID', () => {
  archiveCurrentSession('../../../etc/passwd');
  archiveCurrentSession('not-a-uuid');
  archiveCurrentSession('');
});

test('archiveCurrentSession: skips when transcript file does not exist', () => {
  // Valid UUID but no JSONL file at the hardcoded path — should not throw
  archiveCurrentSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

// NOTE: The following test patches fs to redirect the hardcoded paths to temp dirs.
// It verifies the full archive flow: JSONL → parse → write markdown file.
test('archiveCurrentSession: creates archive file from valid JSONL', (t) => {
  const { tmpDir, sessionId, conversationsDir, transcriptPath } = setupTestEnvironment([
    { type: 'user', content: 'What is the capital of France?' },
    { type: 'assistant', content: 'The capital of France is Paris.' },
  ]);

  const hardcodedProjectDir = '/home/node/.claude/projects/-workspace-group';
  const hardcodedConversationsDir = '/workspace/group/conversations';

  const originalExistsSync = fs.existsSync.bind(fs);
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  const originalWriteFileSync = fs.writeFileSync.bind(fs);

  t.mock.method(fs, 'existsSync', (p: fs.PathLike) => {
    if (String(p) === path.join(hardcodedProjectDir, `${sessionId}.jsonl`)) return true;
    return originalExistsSync(p);
  });

  t.mock.method(fs, 'readFileSync', (p: fs.PathLike | number, ...args: unknown[]) => {
    if (String(p) === path.join(hardcodedProjectDir, `${sessionId}.jsonl`)) {
      return originalReadFileSync(transcriptPath, 'utf-8');
    }
    return (originalReadFileSync as (...a: unknown[]) => unknown)(p, ...args);
  });

  t.mock.method(fs, 'mkdirSync', (p: fs.PathLike, ...args: unknown[]) => {
    if (String(p) === hardcodedConversationsDir) {
      return (originalMkdirSync as (...a: unknown[]) => unknown)(conversationsDir, ...args);
    }
    return (originalMkdirSync as (...a: unknown[]) => unknown)(p, ...args);
  });

  let writtenPath = '';
  let writtenContent = '';
  t.mock.method(fs, 'writeFileSync', (p: fs.PathLike | number, data: unknown, ...args: unknown[]) => {
    const str = String(p);
    if (str.startsWith(hardcodedConversationsDir)) {
      writtenPath = str.replace(hardcodedConversationsDir, conversationsDir);
      writtenContent = String(data);
      return (originalWriteFileSync as (...a: unknown[]) => unknown)(writtenPath, data, ...args);
    }
    return (originalWriteFileSync as (...a: unknown[]) => unknown)(p, data, ...args);
  });

  archiveCurrentSession(sessionId, 'Ren');

  assert.ok(writtenPath !== '', 'Should have written a file');
  assert.ok(writtenContent.includes('What is the capital of France?'), 'Archive should contain user message');
  assert.ok(writtenContent.includes('The capital of France is Paris.'), 'Archive should contain assistant message');
  assert.ok(writtenContent.includes('**Ren**:'), 'Archive should use assistant name');
  assert.ok(writtenContent.includes('Archived:'), 'Archive should have timestamp');

  // Verify filename format: YYYY-MM-DD-conversation-HHMM.md
  const filename = path.basename(writtenPath);
  assert.match(filename, /^\d{4}-\d{2}-\d{2}-conversation-\d{4}\.md$/);

  fs.rmSync(tmpDir, { recursive: true });
});

test('archiveCurrentSession: does not create file for empty transcript', (t) => {
  const sessionId = '00000000-0000-0000-0000-000000000002';
  const hardcodedProjectDir = '/home/node/.claude/projects/-workspace-group';
  const hardcodedConversationsDir = '/workspace/group/conversations';

  // JSONL contains only non-message lines
  const jsonlContent = JSON.stringify({ type: 'system', subtype: 'init' }) + '\n';

  const originalExistsSync = fs.existsSync.bind(fs);
  const originalReadFileSync = fs.readFileSync.bind(fs);

  t.mock.method(fs, 'existsSync', (p: fs.PathLike) => {
    if (String(p) === path.join(hardcodedProjectDir, `${sessionId}.jsonl`)) return true;
    return originalExistsSync(p);
  });

  t.mock.method(fs, 'readFileSync', (p: fs.PathLike | number, ...args: unknown[]) => {
    if (String(p) === path.join(hardcodedProjectDir, `${sessionId}.jsonl`)) {
      return jsonlContent;
    }
    return (originalReadFileSync as (...a: unknown[]) => unknown)(p, ...args);
  });

  let fileWritten = false;
  t.mock.method(fs, 'writeFileSync', (p: fs.PathLike | number, ...args: unknown[]) => {
    if (String(p).startsWith(hardcodedConversationsDir)) {
      fileWritten = true;
    }
    return (fs.writeFileSync as unknown as (...a: unknown[]) => unknown)(p, ...args);
  });

  archiveCurrentSession(sessionId);

  assert.equal(fileWritten, false, 'Should not write a file for empty transcript');
});
