import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  ContainerOutput,
  runContainerAgent,
} from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Maximum IPC file size in bytes. Files larger than this are rejected and deleted. */
const MAX_IPC_FILE_SIZE = 1_000_000; // 1 MB

/** Cap concurrent spawn_agent sub-containers to prevent runaway spawning. */
let activeSpawnAgents = 0;
const MAX_SPAWN_AGENTS = 3;

/** Check file size and reject oversized IPC files. Returns true if file is too large. */
function isOversizedIpcFile(filePath: string, sourceGroup: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_IPC_FILE_SIZE) {
      logger.warn(
        { filePath, size: stat.size, sourceGroup, maxSize: MAX_IPC_FILE_SIZE },
        'Oversized IPC file rejected and deleted',
      );
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    // File may have been deleted between readdir and stat — skip it
    return true;
  }
  return false;
}

/** Per-group message rate limiter: max messages per window. */
const MESSAGE_RATE_LIMIT = 20;
const MESSAGE_RATE_WINDOW_MS = 60_000; // 1 minute

const messageRateBuckets = new Map<
  string,
  { count: number; windowStart: number }
>();

/** Returns true if the message should be rate-limited (rejected). */
function isRateLimited(sourceGroup: string): boolean {
  const now = Date.now();
  const bucket = messageRateBuckets.get(sourceGroup);
  if (!bucket || now - bucket.windowStart > MESSAGE_RATE_WINDOW_MS) {
    messageRateBuckets.set(sourceGroup, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  if (bucket.count > MESSAGE_RATE_LIMIT) {
    logger.warn(
      { sourceGroup, count: bucket.count, limit: MESSAGE_RATE_LIMIT },
      'Outbound message rate limit exceeded — message dropped',
    );
    return true;
  }
  return false;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            if (isOversizedIpcFile(filePath, sourceGroup)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (isRateLimited(sourceGroup)) {
                    fs.unlinkSync(filePath);
                    continue;
                  }
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter(
              (f) => f.endsWith('.json') && !f.startsWith('spawn_result_'),
            );
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            if (isOversizedIpcFile(filePath, sourceGroup)) continue;
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    allowed_tools?: string[];
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For spawn_agent
    requestId?: string;
    sourceGroup?: string;
    description?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        // Block send_email in scheduled tasks — only interactive messages may send email
        if (data.allowed_tools?.includes('mcp__google__send_email')) {
          logger.warn(
            { data },
            'schedule_task cannot include send_email — removed',
          );
          data.allowed_tools = data.allowed_tools.filter(
            (t: string) => t !== 'mcp__google__send_email',
          );
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          allowed_tools: data.allowed_tools
            ? JSON.stringify(data.allowed_tools)
            : null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;
        if (data.allowed_tools !== undefined) {
          // Block send_email in task updates — only interactive messages may send email
          if (data.allowed_tools.includes('mcp__google__send_email')) {
            logger.warn(
              { data },
              'update_task cannot include send_email — removed',
            );
            data.allowed_tools = data.allowed_tools.filter(
              (t: string) => t !== 'mcp__google__send_email',
            );
          }
          updates.allowed_tools = JSON.stringify(data.allowed_tools);
        }

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'spawn_agent': {
      if (!data.requestId || !data.prompt || !data.allowed_tools) {
        logger.warn({ data }, 'Invalid spawn_agent request — missing fields');
        break;
      }
      // Block send_email in spawn_agent — only interactive messages may send email
      if (data.allowed_tools.includes('mcp__google__send_email')) {
        logger.warn(
          { data },
          'spawn_agent cannot include send_email — removed',
        );
        data.allowed_tools = data.allowed_tools.filter(
          (t: string) => t !== 'mcp__google__send_email',
        );
      }
      // Only main group can spawn sub-agents
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized spawn_agent attempt blocked',
        );
        break;
      }

      // Look up the group from registered groups
      const spawnGroup = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      if (!spawnGroup) {
        logger.error(
          { sourceGroup },
          'spawn_agent: source group not found in registered groups',
        );
        break;
      }

      const spawnDesc = data.description || 'sub-agent';

      // Write result file eagerly on first output so the parent agent
      // doesn't have to wait for the sub-agent container to exit (idle timeout).
      const resultDir = path.join(resolveGroupIpcPath(sourceGroup), 'tasks');
      fs.mkdirSync(resultDir, { recursive: true });
      const resultPath = path.join(
        resultDir,
        `spawn_result_${data.requestId}.json`,
      );

      // Enforce sub-agent concurrency limit
      if (activeSpawnAgents >= MAX_SPAWN_AGENTS) {
        logger.warn(
          { requestId: data.requestId, activeSpawnAgents },
          'spawn_agent rejected: too many concurrent sub-agents',
        );
        fs.writeFileSync(
          resultPath,
          JSON.stringify({
            output: 'Error: Too many concurrent sub-agents. Try again later.',
          }),
        );
        break;
      }
      activeSpawnAgents++;

      logger.info(
        {
          requestId: data.requestId,
          sourceGroup,
          description: spawnDesc,
          activeSpawnAgents,
        },
        'Spawning sub-agent',
      );

      let spawnOutput = '';
      let resultWritten = false;

      // Fire-and-forget: don't await — let the container run and exit on its own.
      // The result file is written as soon as the sub-agent produces output.
      runContainerAgent(
        spawnGroup,
        {
          prompt: data.prompt,
          groupFolder: sourceGroup,
          chatJid: data.chatJid || '',
          isMain: false,
          isScheduledTask: true,
          assistantName: ASSISTANT_NAME,
          allowedTools: data.allowed_tools,
        },
        () => {}, // onProcess — not tracking spawned containers in the queue
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            spawnOutput += streamedOutput.result;
          }
          // Write result file on first output callback (even if result is null,
          // it signals the sub-agent has finished its work)
          if (!resultWritten) {
            resultWritten = true;
            fs.writeFileSync(
              resultPath,
              JSON.stringify({ output: spawnOutput }),
            );
            logger.info(
              {
                requestId: data.requestId,
                outputLength: spawnOutput.length,
              },
              'spawn_agent result written',
            );
          }
        },
      )
        .then(() => {
          activeSpawnAgents--;
        })
        .catch((err) => {
          activeSpawnAgents--;
          // Write error result if the container fails and we haven't written yet
          if (!resultWritten) {
            resultWritten = true;
            const errorOutput = `Error: ${err instanceof Error ? err.message : String(err)}`;
            fs.writeFileSync(
              resultPath,
              JSON.stringify({ output: errorOutput }),
            );
            logger.error(
              { requestId: data.requestId, err },
              'spawn_agent sub-agent failed',
            );
          }
        });

      // Don't unlink the request file — the outer loop does that
      break;
    }

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/** @internal — test-only exports */
export {
  isOversizedIpcFile as _isOversizedIpcFile,
  isRateLimited as _isRateLimited,
};

/** @internal — reset rate-limit state between tests */
export function _resetRateLimits(): void {
  messageRateBuckets.clear();
}
