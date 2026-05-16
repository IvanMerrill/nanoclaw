import { describe, expect, it } from 'bun:test';

import { validateSubagentTools } from './subagent-validation.js';
import type { AgentDefinition } from './config.js';

describe('validateSubagentTools', () => {
  it('returns no issues when all MCP-prefixed tools exist', () => {
    const agents: Record<string, AgentDefinition> = {
      classifier: {
        description: 'd',
        prompt: 'p',
        tools: ['mcp__google__read_email', 'mcp__google__list_email_labels'],
      },
    };
    const mcpTools = { google: ['read_email', 'list_email_labels', 'send_email'] };
    expect(validateSubagentTools(agents, mcpTools)).toEqual([]);
  });

  it('flags an MCP tool name that does not exist in its namespace', () => {
    // This is the literal failure mode F2 surfaced: list_labels vs list_email_labels.
    const agents: Record<string, AgentDefinition> = {
      classifier: {
        description: 'd',
        prompt: 'p',
        tools: ['mcp__google__list_labels'],
      },
    };
    const mcpTools = { google: ['read_email', 'list_email_labels'] };
    const issues = validateSubagentTools(agents, mcpTools);
    expect(issues).toHaveLength(1);
    expect(issues[0].subagent).toBe('classifier');
    expect(issues[0].tool).toBe('mcp__google__list_labels');
    expect(issues[0].reason).toMatch(/not found in mcp server "google"/);
  });

  it('flags an MCP namespace that does not match any wired server', () => {
    const agents: Record<string, AgentDefinition> = {
      x: { description: 'd', prompt: 'p', tools: ['mcp__gmaiil__send'] },
    };
    const mcpTools = { google: ['send_email'] };
    const issues = validateSubagentTools(agents, mcpTools);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toMatch(/unknown mcp server "gmaiil"/);
  });

  it('skips validation for non-MCP-prefixed tool names', () => {
    // The SDK has many built-in tools (Read, Write, Bash, Task, etc.). Validating
    // those would require duplicating the provider's allowlist; not worth it.
    const agents: Record<string, AgentDefinition> = {
      x: { description: 'd', prompt: 'p', tools: ['Read', 'Bash', 'Task'] },
    };
    expect(validateSubagentTools(agents, { google: [] })).toEqual([]);
  });

  it('handles multiple subagents and accumulates issues', () => {
    const agents: Record<string, AgentDefinition> = {
      ok: { description: 'd', prompt: 'p', tools: ['mcp__google__read_email'] },
      broken: { description: 'd', prompt: 'p', tools: ['mcp__google__nope'] },
      veryBroken: { description: 'd', prompt: 'p', tools: ['mcp__google__nope', 'mcp__nowhere__x'] },
    };
    const mcpTools = { google: ['read_email'] };
    const issues = validateSubagentTools(agents, mcpTools);
    expect(issues).toHaveLength(3);
    expect(issues.map((i) => i.subagent).sort()).toEqual(['broken', 'veryBroken', 'veryBroken']);
  });

  it('matches MCP server names with underscores after SDK sanitization', () => {
    // The SDK sanitizes server names: any non-[A-Za-z0-9_-] becomes _. The runtime
    // tool prefix uses the sanitized form, so our matching must do the same.
    const agents: Record<string, AgentDefinition> = {
      x: { description: 'd', prompt: 'p', tools: ['mcp__my_server__do_thing'] },
    };
    const mcpTools = { 'my.server': ['do_thing'] };
    expect(validateSubagentTools(agents, mcpTools)).toEqual([]);
  });

  it('returns empty for empty agents map (fast path)', () => {
    expect(validateSubagentTools({}, { google: ['x'] })).toEqual([]);
  });
});
