import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  parseCronNextSafe,
  startSchedulerLoop,
} from './task-scheduler.js';

const mockRunContainerAgent = vi.fn();
const mockWriteTasksSnapshot = vi.fn();
const mockResolveGroupFolderPath = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('./container-runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
  writeTasksSnapshot: (...args: unknown[]) => mockWriteTasksSnapshot(...args),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) =>
    mockResolveGroupFolderPath(folder),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    },
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockResolveGroupFolderPath.mockImplementation((folder: string) => {
      if (folder.includes('..'))
        throw new Error(`Path traversal detected: ${folder}`);
      return `/tmp/test-groups/${folder}`;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      allowed_tools: null,
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      allowed_tools: null,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun does not skip the DST transition day for daily cron tasks', () => {
    vi.setSystemTime(new Date('2026-03-28T07:04:20.000Z'));

    const task = {
      id: 'dst-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'cron' as const,
      schedule_value: '0 8 * * *',
      context_mode: 'isolated' as const,
      allowed_tools: null,
      next_run: '2026-03-28T07:00:00.000Z',
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const result = computeNextRun(task);
    expect(result).toBe('2026-03-29T06:00:00.000Z');
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      allowed_tools: null,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  describe('parseCronNextSafe', () => {
    it('returns correct next occurrence on a normal (non-DST) day', () => {
      const result = parseCronNextSafe(
        '0 8 * * *',
        'Europe/Amsterdam',
        new Date('2026-03-27T07:03:00.000Z'),
      );
      expect(result.toISOString()).toBe('2026-03-28T07:00:00.000Z');
    });

    it('returns the DST transition day when currentDate is in the cron-parser bug window', () => {
      const bugWindowTime = new Date('2026-03-28T07:04:20.000Z');
      const result = parseCronNextSafe(
        '0 8 * * *',
        'Europe/Amsterdam',
        bugWindowTime,
      );
      expect(result.toISOString()).toBe('2026-03-29T06:00:00.000Z');
    });

    it('returns the correct occurrence from the middle of the bug window', () => {
      const midWindow = new Date('2026-03-28T20:00:00.000Z');
      const result = parseCronNextSafe(
        '0 8 * * *',
        'Europe/Amsterdam',
        midWindow,
      );
      expect(result.toISOString()).toBe('2026-03-29T06:00:00.000Z');
    });

    it('returns the correct occurrence from just before the DST transition', () => {
      const justBefore = new Date('2026-03-29T00:59:59.000Z');
      const result = parseCronNextSafe(
        '0 8 * * *',
        'Europe/Amsterdam',
        justBefore,
      );
      expect(result.toISOString()).toBe('2026-03-29T06:00:00.000Z');
    });

    it('does not alter weekly cron results (gap > 25h is correct for weekly)', () => {
      const saturday = new Date('2026-03-28T08:00:00.000Z');
      const result = parseCronNextSafe(
        '0 9 * * 1',
        'Europe/Amsterdam',
        saturday,
      );
      expect(result.toISOString()).toBe('2026-03-30T07:00:00.000Z');
    });

    it('handles fall-back DST (CEST→CET in October) without false trigger', () => {
      const preFallback = new Date('2026-10-25T07:04:00.000Z');
      const result = parseCronNextSafe(
        '0 8 * * *',
        'Europe/Amsterdam',
        preFallback,
      );
      expect(result.toISOString()).toBe('2026-10-26T07:00:00.000Z');
    });
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      allowed_tools: null,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  describe('task error notifications', () => {
    function makeTask(id = 'notify-test') {
      return {
        id,
        group_folder: 'main',
        chat_jid: 'test@g.us',
        prompt: 'Run the morning triage',
        schedule_type: 'once' as const,
        schedule_value: new Date(Date.now() - 1000).toISOString(),
        context_mode: 'isolated' as const,
        allowed_tools: null,
        next_run: new Date(Date.now() - 1000).toISOString(),
        last_run: null,
        last_result: null,
        status: 'active' as const,
        created_at: new Date().toISOString(),
      };
    }

    function makeDeps(sendMessage: ReturnType<typeof vi.fn>) {
      return {
        registeredGroups: () => ({
          'test@g.us': {
            folder: 'main',
            name: 'Test',
            trigger: '@ren',
            added_at: '2026-01-01T00:00:00.000Z',
            isMain: true,
          } as any,
        }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: vi.fn(
            (_jid: string, _id: string, fn: () => Promise<void>) => void fn(),
          ),
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
        onProcess: () => {},
        sendMessage: sendMessage as unknown as (
          jid: string,
          text: string,
        ) => Promise<void>,
      };
    }

    it('sends a notification when the group folder is invalid (Path 1)', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      createTask({
        ...makeTask('path1-test'),
        group_folder: '../../outside',
        chat_jid: 'bad@g.us',
      });

      startSchedulerLoop({
        registeredGroups: () => ({}),
        getSessions: () => ({}),
        queue: {
          enqueueTask: vi.fn(
            (_jid: string, _id: string, fn: () => Promise<void>) => void fn(),
          ),
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
        onProcess: () => {},
        sendMessage,
      });
      await vi.advanceTimersByTimeAsync(100);

      const errorCalls = sendMessage.mock.calls.filter(([, msg]) =>
        (msg as string).includes('⚠️ Scheduled task failed'),
      );
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0][0]).toBe('bad@g.us');
      expect(errorCalls[0][1]).toContain('Path traversal');
    });

    it('sends a notification when the registered group is not found (Path 2)', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      createTask({ ...makeTask('path2-test'), group_folder: 'orphan' });

      startSchedulerLoop({
        registeredGroups: () => ({}),
        getSessions: () => ({}),
        queue: {
          enqueueTask: vi.fn(
            (_jid: string, _id: string, fn: () => Promise<void>) => void fn(),
          ),
          closeStdin: vi.fn(),
          notifyIdle: vi.fn(),
        } as any,
        onProcess: () => {},
        sendMessage,
      });
      await vi.advanceTimersByTimeAsync(100);

      const errorCalls = sendMessage.mock.calls.filter(([, msg]) =>
        (msg as string).includes('⚠️ Scheduled task failed'),
      );
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0][1]).toContain('Group not found');
    });

    it('sends a notification when the container reports an error (Path 3)', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      createTask(makeTask());

      mockRunContainerAgent.mockResolvedValueOnce({
        status: 'error',
        error: 'Container OOM killed',
      });

      startSchedulerLoop(makeDeps(sendMessage));
      await vi.advanceTimersByTimeAsync(100);

      const errorCalls = sendMessage.mock.calls.filter(([, msg]) =>
        (msg as string).includes('⚠️ Scheduled task failed'),
      );
      expect(errorCalls).toHaveLength(1);
      const [jid, message] = errorCalls[0];
      expect(jid).toBe('test@g.us');
      expect(message).toContain('Run the morning triage');
      expect(message).toContain('Container OOM killed');
    });

    it('does not send an error notification on task success', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      createTask(makeTask('success-test'));

      mockRunContainerAgent.mockResolvedValueOnce({
        status: 'success',
        result: 'Triage complete.',
      });

      startSchedulerLoop(makeDeps(sendMessage));
      await vi.advanceTimersByTimeAsync(100);

      const errorCalls = sendMessage.mock.calls.filter(([, msg]) =>
        (msg as string).includes('⚠️ Scheduled task failed'),
      );
      expect(errorCalls).toHaveLength(0);
    });

    it('does not throw or skip updateTaskAfterRun if sendMessage itself fails', async () => {
      const sendMessage = vi.fn().mockRejectedValue(new Error('Telegram down'));
      createTask(makeTask('resilience-test'));

      mockRunContainerAgent.mockResolvedValueOnce({
        status: 'error',
        error: 'Container OOM killed',
      });

      startSchedulerLoop(makeDeps(sendMessage));
      await expect(vi.advanceTimersByTimeAsync(100)).resolves.not.toThrow();

      const task = getTaskById('resilience-test');
      expect(task?.next_run).toBeNull();
    });
  });
});
