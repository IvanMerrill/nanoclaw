import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { defineSubagent, removeSubagent } from './self-mod.js';

beforeEach(() => {
  initTestSessionDb();
});
afterEach(() => {
  closeSessionDb();
});

describe('define_subagent MCP tool', () => {
  it('writes a system action to messages_out with the full payload', async () => {
    const res = await defineSubagent.handler({
      name: 'email-classifier',
      description: 'Read-only triage',
      prompt: 'Triage emails.',
      tools: ['mcp__google__search_emails', 'mcp__google__read_email'],
    });
    expect(res.isError).toBeFalsy();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('system');
    const content = JSON.parse(out[0].content);
    expect(content).toEqual({
      action: 'define_subagent',
      name: 'email-classifier',
      description: 'Read-only triage',
      prompt: 'Triage emails.',
      tools: ['mcp__google__search_emails', 'mcp__google__read_email'],
      model: undefined,
    });
  });

  it('forwards an optional model', async () => {
    await defineSubagent.handler({
      name: 'email-classifier',
      description: 'd',
      prompt: 'p',
      tools: ['t'],
      model: 'sonnet',
    });
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.model).toBe('sonnet');
  });

  it('rejects missing required fields', async () => {
    const res = await defineSubagent.handler({ name: '', description: 'd', prompt: 'p', tools: ['t'] });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects empty tools array', async () => {
    const res = await defineSubagent.handler({ name: 'n', description: 'd', prompt: 'p', tools: [] });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('remove_subagent MCP tool', () => {
  it('writes a remove action to messages_out', async () => {
    const res = await removeSubagent.handler({ name: 'email-classifier' });
    expect(res.isError).toBeFalsy();
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content).toEqual({ action: 'remove_subagent', name: 'email-classifier' });
  });

  it('rejects missing name', async () => {
    const res = await removeSubagent.handler({ name: '' });
    expect(res.isError).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
