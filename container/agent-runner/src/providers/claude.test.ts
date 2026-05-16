import { describe, it, expect, mock } from 'bun:test';

import type { AgentDefinition } from '../config.js';

const sdkQueryMock = mock(() => {
  return (async function* () {})();
});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: sdkQueryMock,
}));

const { ClaudeProvider } = await import('./claude.js');

describe('ClaudeProvider — agents option', () => {
  it('forwards agents from constructor into sdkQuery options', () => {
    sdkQueryMock.mockClear();
    const agents: Record<string, AgentDefinition> = {
      'email-classifier': {
        description: 'Triage',
        prompt: 'Triage emails.',
        tools: ['mcp__google__read_email'],
      },
    };
    const provider = new ClaudeProvider({ agents });
    provider.query({ prompt: 'hi', cwd: '/tmp' });

    expect(sdkQueryMock).toHaveBeenCalled();
    const callArg = sdkQueryMock.mock.calls[0][0] as { options: { agents: typeof agents } };
    expect(callArg.options.agents).toEqual(agents);
  });

  it('defaults agents to an empty object when not provided', () => {
    sdkQueryMock.mockClear();
    const provider = new ClaudeProvider({});
    provider.query({ prompt: 'hi', cwd: '/tmp' });

    const callArg = sdkQueryMock.mock.calls[0][0] as { options: { agents: object } };
    expect(callArg.options.agents).toEqual({});
  });
});
