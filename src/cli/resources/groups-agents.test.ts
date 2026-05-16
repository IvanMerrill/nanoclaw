import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  ensureContainerConfig,
  getContainerConfig,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { lookup } from '../registry.js';

// Importing groups.ts registers the verbs into the global registry.
import '../resources/groups.js';

import type { CallerContext } from '../frame.js';
import type { AgentDefinition } from '../../types.js';

function seedGroup(id: string): void {
  createAgentGroup({
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  ensureContainerConfig(id);
}

const ctx: CallerContext = { caller: 'host' };

function command(name: string) {
  const def = lookup(name);
  if (!def) throw new Error(`Command not registered: ${name}`);
  return (args: Record<string, unknown>) => def.handler(args, ctx);
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('ncl groups config agents list', () => {
  it('returns the parsed agents map for a valid group', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-list');
    const result = (await run({ id: 'ag-1' })) as { agents: Record<string, AgentDefinition> };
    expect(result.agents).toEqual({});
  });

  it('throws when --id is missing', async () => {
    const run = command('groups-config-agents-list');
    await expect(run({})).rejects.toThrow(/--id is required/);
  });

  it('throws for an unknown group', async () => {
    const run = command('groups-config-agents-list');
    await expect(run({ id: 'unknown' })).rejects.toThrow(/No container config for group/);
  });
});

describe('ncl groups config agents add', () => {
  let tmpDir: string;
  let promptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-add-'));
    promptPath = path.join(tmpDir, 'prompt.txt');
    fs.writeFileSync(promptPath, 'You triage emails carefully.');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('adds a subagent under the agents map (happy path)', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await run({
      id: 'ag-1',
      name: 'email-classifier',
      description: 'Read-only triage',
      'prompt-file': promptPath,
      tools: 'mcp__google__search_emails,mcp__google__read_email',
    });
    const row = getContainerConfig('ag-1')!;
    const agents = JSON.parse(row.agents) as Record<string, AgentDefinition>;
    expect(agents['email-classifier']).toEqual({
      description: 'Read-only triage',
      prompt: 'You triage emails carefully.',
      tools: ['mcp__google__search_emails', 'mcp__google__read_email'],
    });
  });

  it('records --model when present', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await run({
      id: 'ag-1',
      name: 'x',
      description: 'd',
      'prompt-file': promptPath,
      tools: 't',
      model: 'sonnet',
    });
    const agents = JSON.parse(getContainerConfig('ag-1')!.agents) as Record<string, AgentDefinition>;
    expect(agents.x.model).toBe('sonnet');
  });

  it('throws when --id is missing', async () => {
    const run = command('groups-config-agents-add');
    await expect(run({ name: 'x', description: 'd', 'prompt-file': promptPath, tools: 't' })).rejects.toThrow(
      /--id is required/,
    );
  });

  it('throws when --name is missing', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await expect(run({ id: 'ag-1', description: 'd', 'prompt-file': promptPath, tools: 't' })).rejects.toThrow(
      /--name is required/,
    );
  });

  it('throws when --description is missing', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await expect(run({ id: 'ag-1', name: 'x', 'prompt-file': promptPath, tools: 't' })).rejects.toThrow(
      /--description is required/,
    );
  });

  it('throws when --prompt-file is missing', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await expect(run({ id: 'ag-1', name: 'x', description: 'd', tools: 't' })).rejects.toThrow(
      /--prompt-file is required/,
    );
  });

  it('throws when the prompt file does not exist', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await expect(
      run({
        id: 'ag-1',
        name: 'x',
        description: 'd',
        'prompt-file': '/no/such/path.txt',
        tools: 't',
      }),
    ).rejects.toThrow(/Prompt file not found.*\/no\/such\/path\.txt/);
  });

  it('throws when --tools is missing', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await expect(run({ id: 'ag-1', name: 'x', description: 'd', 'prompt-file': promptPath })).rejects.toThrow(
      /--tools is required/,
    );
  });

  it('throws when --tools is empty', async () => {
    seedGroup('ag-1');
    const run = command('groups-config-agents-add');
    await expect(
      run({ id: 'ag-1', name: 'x', description: 'd', 'prompt-file': promptPath, tools: ' , , ' }),
    ).rejects.toThrow(/--tools must contain at least one tool/);
  });
});

describe('ncl groups config agents remove', () => {
  it('removes a named subagent', async () => {
    seedGroup('ag-1');
    // Seed an agents map first
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-rm-'));
    const promptPath = path.join(tmpDir, 'prompt.txt');
    fs.writeFileSync(promptPath, 'p');
    try {
      const add = command('groups-config-agents-add');
      await add({ id: 'ag-1', name: 'x', description: 'd', 'prompt-file': promptPath, tools: 't' });

      const remove = command('groups-config-agents-remove');
      await remove({ id: 'ag-1', name: 'x' });

      const agents = JSON.parse(getContainerConfig('ag-1')!.agents);
      expect(agents).not.toHaveProperty('x');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws when removing a non-existent name', async () => {
    seedGroup('ag-1');
    const remove = command('groups-config-agents-remove');
    await expect(remove({ id: 'ag-1', name: 'missing' })).rejects.toThrow(/Subagent "missing" not found/);
  });

  it('throws when --id is missing', async () => {
    const remove = command('groups-config-agents-remove');
    await expect(remove({ name: 'x' })).rejects.toThrow(/--id is required/);
  });

  it('throws when --name is missing', async () => {
    seedGroup('ag-1');
    const remove = command('groups-config-agents-remove');
    await expect(remove({ id: 'ag-1' })).rejects.toThrow(/--name is required/);
  });
});
