import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  ensureContainerConfig,
  getContainerConfig,
  initTestDb,
  runMigrations,
  updateContainerConfigJson,
} from './index.js';
import type { AgentDefinition } from '../types.js';

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

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => closeDb());

describe('container-configs — agents JSON column', () => {
  it('round-trips an agents map through updateContainerConfigJson + getContainerConfig', () => {
    seedGroup('ag-test');

    const agents: Record<string, AgentDefinition> = {
      'email-classifier': {
        description: 'Read-only email triage',
        prompt: 'You triage emails.',
        tools: ['mcp__google__search_emails', 'mcp__google__read_email'],
      },
    };
    updateContainerConfigJson('ag-test', 'agents', agents);

    const row = getContainerConfig('ag-test')!;
    expect(JSON.parse(row.agents)).toEqual(agents);
  });

  it('preserves existing entries when overwritten with a new map', () => {
    seedGroup('ag-test');
    updateContainerConfigJson('ag-test', 'agents', {
      a: { description: 'a', prompt: 'a', tools: ['t1'] },
    });
    updateContainerConfigJson('ag-test', 'agents', {
      a: { description: 'a', prompt: 'a', tools: ['t1'] },
      b: { description: 'b', prompt: 'b', tools: ['t2'] },
    });
    const row = getContainerConfig('ag-test')!;
    expect(Object.keys(JSON.parse(row.agents))).toEqual(['a', 'b']);
  });

  it('rejects writes to non-JSON columns', () => {
    expect(() => updateContainerConfigJson('ag-x', 'provider' as never, {})).toThrow(/Invalid JSON column/);
  });
});
