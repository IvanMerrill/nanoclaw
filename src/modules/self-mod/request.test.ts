import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  notifyAgent: vi.fn(),
  applyDefineSubagent: vi.fn(),
  applyRemoveSubagent: vi.fn(),
  applyInstallPackages: vi.fn(),
  applyAddMcpServer: vi.fn(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: mocks.requestApproval,
  notifyAgent: mocks.notifyAgent,
}));
vi.mock('./apply.js', () => ({
  applyDefineSubagent: mocks.applyDefineSubagent,
  applyRemoveSubagent: mocks.applyRemoveSubagent,
  applyInstallPackages: mocks.applyInstallPackages,
  applyAddMcpServer: mocks.applyAddMcpServer,
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => ({
    id: 'ag-test',
    name: 'Ren',
    folder: 'ren',
    agent_provider: null,
    created_at: '',
  })),
}));

import { handleDefineSubagent, handleRemoveSubagent } from './request.js';
import type { Session } from '../../types.js';

const session = { id: 's1', agent_group_id: 'ag-test' } as Session;

beforeEach(() => {
  mocks.requestApproval.mockClear();
  mocks.notifyAgent.mockClear();
  mocks.applyDefineSubagent.mockClear();
  mocks.applyRemoveSubagent.mockClear();
});

describe('handleDefineSubagent — no approval gate', () => {
  it('calls applyDefineSubagent directly without requesting approval', async () => {
    await handleDefineSubagent(
      {
        name: 'email-classifier',
        description: 'Triage',
        prompt: 'Triage.',
        tools: ['mcp__google__read_email'],
      },
      session,
    );

    expect(mocks.requestApproval).not.toHaveBeenCalled();
    expect(mocks.applyDefineSubagent).toHaveBeenCalledTimes(1);
  });

  it('notifies and returns when required fields are missing', async () => {
    await handleDefineSubagent({ name: '', description: 'd', prompt: 'p', tools: ['t'] }, session);
    expect(mocks.applyDefineSubagent).not.toHaveBeenCalled();
    expect(mocks.notifyAgent).toHaveBeenCalled();
  });

  it('notifies and returns when tools array is empty', async () => {
    await handleDefineSubagent({ name: 'n', description: 'd', prompt: 'p', tools: [] }, session);
    expect(mocks.applyDefineSubagent).not.toHaveBeenCalled();
    expect(mocks.notifyAgent).toHaveBeenCalled();
  });
});

describe('handleRemoveSubagent — no approval gate', () => {
  it('calls applyRemoveSubagent directly', async () => {
    await handleRemoveSubagent({ name: 'email-classifier' }, session);
    expect(mocks.requestApproval).not.toHaveBeenCalled();
    expect(mocks.applyRemoveSubagent).toHaveBeenCalledTimes(1);
  });

  it('notifies and returns when name is missing', async () => {
    await handleRemoveSubagent({ name: '' }, session);
    expect(mocks.applyRemoveSubagent).not.toHaveBeenCalled();
    expect(mocks.notifyAgent).toHaveBeenCalled();
  });
});
