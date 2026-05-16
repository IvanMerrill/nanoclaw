/**
 * Subagent tool-name validation.
 *
 * Surfaces a specific failure mode of the SDK's `agents` parameter: if a
 * subagent's `tools` allowlist contains a tool name that doesn't actually
 * exist, the SDK silently drops it and the subagent runs with that name
 * missing from its tool set. When asked to call a non-existent tool, the
 * subagent hallucinates a plausible response instead of erroring.
 *
 * We only validate MCP-prefixed names (`mcp__<server>__<tool>`). Built-in
 * tool names are provider-specific and would require duplicating the
 * provider's allowlist here.
 *
 * This is a WARN-only guard — invalid entries don't block container start.
 * The signal is intended for the human reviewing the logs.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { AgentDefinition, RunnerConfig } from './config.js';

export interface SubagentToolIssue {
  subagent: string;
  tool: string;
  reason: string;
}

const MCP_PREFIX = 'mcp__';

// Mirror the SDK's server-name sanitization (any non-[A-Za-z0-9_-] → '_').
// Used to match a subagent's `mcp__<sanitized>__<tool>` reference back to a
// wired server name in container.json.
function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Pure validation. Given a subagent definitions map and a map of available
 * MCP tools (keyed by raw server name as it appears in container.json),
 * return the list of issues. Empty array = all good.
 */
export function validateSubagentTools(
  agents: Record<string, AgentDefinition>,
  mcpToolsByServer: Record<string, string[]>,
): SubagentToolIssue[] {
  const subagentNames = Object.keys(agents);
  if (subagentNames.length === 0) return [];

  // Build sanitized-name → tool[] for fast lookup.
  const bySanitized = new Map<string, string[]>();
  for (const [raw, tools] of Object.entries(mcpToolsByServer)) {
    bySanitized.set(sanitizeServerName(raw), tools);
  }

  const issues: SubagentToolIssue[] = [];
  for (const name of subagentNames) {
    for (const tool of agents[name].tools) {
      if (!tool.startsWith(MCP_PREFIX)) continue;
      const rest = tool.slice(MCP_PREFIX.length);
      const sep = rest.indexOf('__');
      if (sep === -1) {
        issues.push({ subagent: name, tool, reason: `malformed mcp tool name (missing __<toolname>)` });
        continue;
      }
      const server = rest.slice(0, sep);
      const toolName = rest.slice(sep + 2);
      const known = bySanitized.get(server);
      if (!known) {
        issues.push({ subagent: name, tool, reason: `unknown mcp server "${server}"` });
        continue;
      }
      if (!known.includes(toolName)) {
        issues.push({ subagent: name, tool, reason: `tool "${toolName}" not found in mcp server "${server}"` });
      }
    }
  }
  return issues;
}

/**
 * Spawn each wired MCP server briefly and ask it `tools/list` so we know
 * what names are actually available. Returns a map keyed by the raw server
 * name as it appears in container.json. Errors talking to any single server
 * are swallowed (returns empty tool list for that server) — we don't want a
 * misconfigured MCP to block container startup.
 */
export async function discoverMcpTools(mcpServers: RunnerConfig['mcpServers']): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  await Promise.all(
    Object.entries(mcpServers).map(async ([name, config]) => {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: { ...process.env, ...config.env } as Record<string, string>,
        });
        const client = new Client({ name: 'nanoclaw-subagent-validation', version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        const listing = await client.listTools();
        result[name] = listing.tools.map((t) => t.name);
        await client.close();
      } catch (err) {
        console.error(`[subagent-validation] Failed to introspect MCP server "${name}": ${err instanceof Error ? err.message : String(err)}`);
        result[name] = [];
      }
    }),
  );
  return result;
}

/**
 * Convenience wrapper: discover + validate + log. Used at agent-runner startup.
 */
export async function validateSubagentsAtStartup(
  agents: Record<string, AgentDefinition>,
  mcpServers: RunnerConfig['mcpServers'],
): Promise<SubagentToolIssue[]> {
  if (Object.keys(agents).length === 0) return [];
  const mcpTools = await discoverMcpTools(mcpServers);
  const issues = validateSubagentTools(agents, mcpTools);
  for (const issue of issues) {
    console.error(`[subagent-validation] WARN: subagent "${issue.subagent}" lists tool "${issue.tool}" — ${issue.reason}`);
  }
  return issues;
}
