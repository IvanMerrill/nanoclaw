import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import type { AgentDefinition, AgentGroup, ContainerConfigRow } from './types.js';

const baseGroup: AgentGroup = {
  id: 'ag-test',
  name: 'Test',
  folder: 'test',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

const baseRow: ContainerConfigRow = {
  agent_group_id: 'ag-test',
  provider: 'claude',
  model: null,
  effort: null,
  image_tag: null,
  assistant_name: null,
  max_messages_per_prompt: null,
  skills: '"all"',
  mcp_servers: '{}',
  packages_apt: '[]',
  packages_npm: '[]',
  additional_mounts: '[]',
  cli_scope: 'group',
  agents: '{}',
  updated_at: new Date().toISOString(),
};

describe('configFromDb — agents field', () => {
  it('parses an empty agents JSON to an empty map', () => {
    const cfg = configFromDb(baseRow, baseGroup);
    expect(cfg.agents).toEqual({});
  });

  it('parses a populated agents JSON into a typed map', () => {
    const agents: Record<string, AgentDefinition> = {
      'email-classifier': {
        description: 'Read-only triage',
        prompt: 'Triage emails.',
        tools: ['mcp__google__read_email'],
      },
    };
    const cfg = configFromDb({ ...baseRow, agents: JSON.stringify(agents) }, baseGroup);
    expect(cfg.agents).toEqual(agents);
  });

  it('forwards an optional model field for a subagent', () => {
    const agents: Record<string, AgentDefinition> = {
      x: { description: 'd', prompt: 'p', tools: ['t'], model: 'sonnet' },
    };
    const cfg = configFromDb({ ...baseRow, agents: JSON.stringify(agents) }, baseGroup);
    expect(cfg.agents!.x.model).toBe('sonnet');
  });
});
