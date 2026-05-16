import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadConfig } from './config.js';

describe('loadConfig — agents field', () => {
  let tmpDir: string;
  let cfgPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cfg-'));
    cfgPath = path.join(tmpDir, 'container.json');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('parses an agents map from container.json', () => {
    const cfg = {
      mcpServers: {},
      agents: {
        'email-classifier': {
          description: 'Triage',
          prompt: 'Triage.',
          tools: ['mcp__google__read_email'],
        },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const loaded = loadConfig(cfgPath);
    expect(loaded.agents).toEqual(cfg.agents);
  });

  it('defaults agents to an empty object when missing', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: {} }));
    const loaded = loadConfig(cfgPath);
    expect(loaded.agents).toEqual({});
  });

  it('forwards optional model on a subagent', () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {},
        agents: { x: { description: 'd', prompt: 'p', tools: ['t'], model: 'sonnet' } },
      }),
    );
    const loaded = loadConfig(cfgPath);
    expect(loaded.agents.x.model).toBe('sonnet');
  });
});
