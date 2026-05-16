import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
  writeSessionMessage: vi.fn(),
  updateContainerConfigJson: vi.fn(),
  getContainerConfig: vi.fn(),
  getSession: vi.fn(),
  getAgentGroup: vi.fn(),
}));

vi.mock('../../container-runner.js', () => ({
  killContainer: mocks.killContainer,
  wakeContainer: mocks.wakeContainer,
  buildAgentGroupImage: mocks.buildAgentGroupImage,
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: mocks.writeSessionMessage,
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: mocks.getContainerConfig,
  updateContainerConfigJson: mocks.updateContainerConfigJson,
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: mocks.getAgentGroup,
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: mocks.getSession,
}));

import { applyDefineSubagent, applyRemoveSubagent } from './apply.js';
import type { Session } from '../../types.js';

const session = { id: 's1', agent_group_id: 'ag-test' } as Session;

beforeEach(() => {
  mocks.killContainer.mockClear();
  mocks.wakeContainer.mockClear();
  mocks.writeSessionMessage.mockClear();
  mocks.updateContainerConfigJson.mockClear();
  mocks.getContainerConfig.mockReset();
  mocks.getContainerConfig.mockReturnValue({ agents: '{}' });
  mocks.getSession.mockReturnValue({ id: 's1' });
  mocks.getAgentGroup.mockReturnValue({
    id: 'ag-test',
    name: 'Ren',
    folder: 'ren',
    agent_provider: null,
    created_at: '',
  });
});

describe('applyDefineSubagent', () => {
  it('writes the subagent to the agents map and restarts the container', async () => {
    await applyDefineSubagent(
      {
        name: 'email-classifier',
        description: 'Triage',
        prompt: 'Triage.',
        tools: ['mcp__google__read_email'],
      },
      session,
    );

    expect(mocks.updateContainerConfigJson).toHaveBeenCalledWith(
      'ag-test',
      'agents',
      expect.objectContaining({
        'email-classifier': {
          description: 'Triage',
          prompt: 'Triage.',
          tools: ['mcp__google__read_email'],
        },
      }),
    );
    expect(mocks.writeSessionMessage).toHaveBeenCalledWith('ag-test', 's1', expect.objectContaining({ onWake: 1 }));
    expect(mocks.killContainer).toHaveBeenCalledWith('s1', expect.any(String), expect.any(Function));
  });

  it('preserves existing subagents when adding a new one', async () => {
    mocks.getContainerConfig.mockReturnValue({
      agents: JSON.stringify({ 'old-one': { description: 'd', prompt: 'p', tools: ['t'] } }),
    });
    await applyDefineSubagent(
      {
        name: 'new-one',
        description: 'd2',
        prompt: 'p2',
        tools: ['t2'],
      },
      session,
    );

    const writtenMap = mocks.updateContainerConfigJson.mock.calls[0][2] as Record<string, unknown>;
    expect(Object.keys(writtenMap)).toEqual(expect.arrayContaining(['old-one', 'new-one']));
  });

  it('overwrites an existing subagent with the same name', async () => {
    mocks.getContainerConfig.mockReturnValue({
      agents: JSON.stringify({ x: { description: 'old', prompt: 'old', tools: ['old'] } }),
    });
    await applyDefineSubagent(
      {
        name: 'x',
        description: 'new',
        prompt: 'new',
        tools: ['new'],
      },
      session,
    );

    const writtenMap = mocks.updateContainerConfigJson.mock.calls[0][2] as Record<string, { description: string }>;
    expect(writtenMap.x.description).toBe('new');
  });

  it('forwards optional model field', async () => {
    await applyDefineSubagent(
      {
        name: 'n',
        description: 'd',
        prompt: 'p',
        tools: ['t'],
        model: 'sonnet',
      },
      session,
    );
    const writtenMap = mocks.updateContainerConfigJson.mock.calls[0][2] as Record<string, { model?: string }>;
    expect(writtenMap.n.model).toBe('sonnet');
  });
});

describe('applyRemoveSubagent', () => {
  it('removes the named subagent and restarts the container', async () => {
    mocks.getContainerConfig.mockReturnValue({
      agents: JSON.stringify({ x: { description: 'd', prompt: 'p', tools: ['t'] } }),
    });
    await applyRemoveSubagent({ name: 'x' }, session);

    const writtenMap = mocks.updateContainerConfigJson.mock.calls[0][2] as Record<string, unknown>;
    expect(writtenMap).not.toHaveProperty('x');
    expect(mocks.killContainer).toHaveBeenCalled();
  });

  it('is a no-op when the named subagent does not exist', async () => {
    mocks.getContainerConfig.mockReturnValue({ agents: '{}' });
    await applyRemoveSubagent({ name: 'missing' }, session);

    expect(mocks.updateContainerConfigJson).not.toHaveBeenCalled();
    expect(mocks.killContainer).not.toHaveBeenCalled();
  });
});
