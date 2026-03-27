import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock container-runner
const mockRunContainerAgent = vi.fn();
vi.mock('./container-runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: (group: string) => `/tmp/ipc/${group}`,
  isValidGroupFolder: () => true,
}));

// Mock fs
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      existsSync: () => true,
      readdirSync: () => [],
      statSync: () => ({ isDirectory: () => true, size: 100 }),
      readFileSync: () => '{}',
      unlinkSync: vi.fn(),
      renameSync: vi.fn(),
    },
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

// Mock db
vi.mock('./db.js', () => ({
  createTask: vi.fn(),
  deleteTask: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
}));

// Mock config
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  DATA_DIR: '/tmp/data',
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

// Mock cron-parser
vi.mock('cron-parser', () => ({
  CronExpressionParser: { parse: vi.fn() },
}));

import { processTaskIpc, IpcDeps } from './ipc.js';
import { logger } from './logger.js';

function createDeps(): IpcDeps {
  return {
    sendMessage: vi.fn(),
    registeredGroups: () => ({
      'chat@g.us': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    }),
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the activeSpawnAgents counter by re-importing would be complex,
  // so we rely on test ordering: concurrency tests run their own controlled sequences
});

describe('spawn_agent IPC', () => {
  it('rejects missing requestId', async () => {
    const deps = createDeps();
    await processTaskIpc(
      { type: 'spawn_agent', prompt: 'test', allowed_tools: ['Bash'] },
      'main',
      true,
      deps,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('missing fields'),
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('rejects missing prompt', async () => {
    const deps = createDeps();
    await processTaskIpc(
      { type: 'spawn_agent', requestId: 'req-1', allowed_tools: ['Bash'] },
      'main',
      true,
      deps,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('missing fields'),
    );
  });

  it('rejects missing allowed_tools', async () => {
    const deps = createDeps();
    await processTaskIpc(
      { type: 'spawn_agent', requestId: 'req-1', prompt: 'test' },
      'main',
      true,
      deps,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('missing fields'),
    );
  });

  it('blocks non-main group', async () => {
    const deps = createDeps();
    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-1',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'other-group',
      false,
      deps,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceGroup: 'other-group' }),
      expect.stringContaining('Unauthorized spawn_agent'),
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('blocks source group not in registered groups', async () => {
    const deps = createDeps();
    deps.registeredGroups = () => ({}); // no groups registered

    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-1',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'main',
      true,
      deps,
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sourceGroup: 'main' }),
      expect.stringContaining('source group not found'),
    );
    expect(mockRunContainerAgent).not.toHaveBeenCalled();
  });

  it('calls runContainerAgent with correct params', async () => {
    const deps = createDeps();
    mockRunContainerAgent.mockResolvedValueOnce(undefined);

    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-1',
        prompt: 'do work',
        allowed_tools: ['Bash', 'Read'],
        description: 'helper',
      },
      'main',
      true,
      deps,
    );

    expect(mockRunContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'main' }),
      expect.objectContaining({
        prompt: 'do work',
        groupFolder: 'main',
        allowedTools: ['Bash', 'Read'],
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('writes result file on successful output', async () => {
    const deps = createDeps();

    // Capture the onOutput callback and call it
    mockRunContainerAgent.mockImplementationOnce(
      async (_group: unknown, _opts: unknown, _onProcess: unknown, onOutput: (o: { result: string }) => void) => {
        onOutput({ result: 'task completed' });
      },
    );

    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-write',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'main',
      true,
      deps,
    );

    // Wait for the fire-and-forget promise to settle
    await vi.waitFor(() => {
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('spawn_result_req-write.json'),
        expect.stringContaining('task completed'),
      );
    });
  });

  it('writes error result when container rejects', async () => {
    const deps = createDeps();
    mockRunContainerAgent.mockRejectedValueOnce(new Error('container crash'));

    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-err',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'main',
      true,
      deps,
    );

    // Wait for the catch handler
    await vi.waitFor(() => {
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('spawn_result_req-err.json'),
        expect.stringContaining('container crash'),
      );
    });
  });

  it('does not await runContainerAgent (fire-and-forget)', async () => {
    const deps = createDeps();
    let resolveContainer: () => void;
    const containerPromise = new Promise<void>((r) => {
      resolveContainer = r;
    });
    mockRunContainerAgent.mockReturnValueOnce(containerPromise);

    // processTaskIpc should return immediately without waiting for the container
    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-ff',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'main',
      true,
      deps,
    );

    // processTaskIpc returned — container is still running
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-ff' }),
      'Spawning sub-agent',
    );

    // Resolve container to clean up
    resolveContainer!();
    await containerPromise;
  });

  it('uses default description "sub-agent" when not provided', async () => {
    const deps = createDeps();
    mockRunContainerAgent.mockResolvedValueOnce(undefined);

    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-desc',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'main',
      true,
      deps,
    );

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'sub-agent' }),
      'Spawning sub-agent',
    );
  });

  it('creates result directory with mkdirSync', async () => {
    const deps = createDeps();
    mockRunContainerAgent.mockResolvedValueOnce(undefined);

    await processTaskIpc(
      {
        type: 'spawn_agent',
        requestId: 'req-mkdir',
        prompt: 'test',
        allowed_tools: ['Bash'],
      },
      'main',
      true,
      deps,
    );

    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/ipc/main/tasks',
      { recursive: true },
    );
  });

  describe('concurrency cap', () => {
    it('rejects 4th concurrent spawn and writes error result', async () => {
      const deps = createDeps();
      const resolvers: Array<() => void> = [];

      // First 3 spawns: never resolve (hold the concurrency slots)
      for (let i = 0; i < 3; i++) {
        mockRunContainerAgent.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolvers.push(resolve);
            }),
        );

        await processTaskIpc(
          {
            type: 'spawn_agent',
            requestId: `req-cap-${i}`,
            prompt: 'test',
            allowed_tools: ['Bash'],
          },
          'main',
          true,
          deps,
        );
      }

      // Clear writes from the first 3 spawns
      mockWriteFileSync.mockClear();

      // 4th spawn should be rejected
      await processTaskIpc(
        {
          type: 'spawn_agent',
          requestId: 'req-cap-rejected',
          prompt: 'test',
          allowed_tools: ['Bash'],
        },
        'main',
        true,
        deps,
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-cap-rejected' }),
        expect.stringContaining('too many concurrent'),
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('spawn_result_req-cap-rejected.json'),
        expect.stringContaining('Too many concurrent sub-agents'),
      );

      // Clean up: resolve all pending containers
      for (const resolve of resolvers) resolve();
      // Allow microtasks to settle
      await new Promise((r) => setTimeout(r, 10));
    });

    it('decrements counter on success, allowing new spawn', async () => {
      const deps = createDeps();
      mockRunContainerAgent.mockResolvedValueOnce(undefined);

      await processTaskIpc(
        {
          type: 'spawn_agent',
          requestId: 'req-dec-ok',
          prompt: 'test',
          allowed_tools: ['Bash'],
        },
        'main',
        true,
        deps,
      );

      // Wait for the promise to settle (decrement counter)
      await new Promise((r) => setTimeout(r, 10));

      // Should be able to spawn again
      mockRunContainerAgent.mockResolvedValueOnce(undefined);
      await processTaskIpc(
        {
          type: 'spawn_agent',
          requestId: 'req-dec-ok-2',
          prompt: 'test',
          allowed_tools: ['Bash'],
        },
        'main',
        true,
        deps,
      );

      expect(mockRunContainerAgent).toHaveBeenCalledTimes(2);
    });

    it('decrements counter on failure, allowing new spawn', async () => {
      const deps = createDeps();
      mockRunContainerAgent.mockRejectedValueOnce(new Error('fail'));

      await processTaskIpc(
        {
          type: 'spawn_agent',
          requestId: 'req-dec-fail',
          prompt: 'test',
          allowed_tools: ['Bash'],
        },
        'main',
        true,
        deps,
      );

      // Wait for the catch handler to decrement
      await new Promise((r) => setTimeout(r, 10));

      // Should be able to spawn again
      mockRunContainerAgent.mockResolvedValueOnce(undefined);
      await processTaskIpc(
        {
          type: 'spawn_agent',
          requestId: 'req-dec-fail-2',
          prompt: 'test',
          allowed_tools: ['Bash'],
        },
        'main',
        true,
        deps,
      );

      expect(mockRunContainerAgent).toHaveBeenCalledTimes(2);
    });
  });
});
