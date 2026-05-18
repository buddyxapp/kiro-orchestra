/**
 * Orchestrator — event-driven master loop with inbox + wiki + task management.
 * Master only wakes when inbox has new events AND master is idle.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type SessionManager } from './sessionManager.js';
import { type TaskStore } from './taskStore.js';
import { parseTaskCommands } from './taskCommandParser.js';
import { type AcpEvent } from './acpProtocol.js';
import { logger } from './logger.js';

export interface InboxEvent {
  timestamp: string;
  from: string;
  summary: string;
  fullText?: string;
  savedTo?: string;
  image?: { media_type: string; data: string };
  taskId?: string;
}

export interface Orchestrator {
  pushUserMessage(text: string, image?: { media_type: string; data: string }, taskId?: string): void;
  pushWorkerReport(workerId: string, workerName: string, text: string): void;
  abort(): void;
}

const MAX_SUMMARY_LEN = 300;
const MAX_ROUNDS_PER_MIN = 10;
const DEBOUNCE_MS = 1500;

export function createOrchestrator(
  sm: SessionManager,
  taskStore: TaskStore,
  onEvent: (agentId: string, event: AcpEvent) => void,
  onBroadcastSessions: () => void,
  onBroadcastTasks: () => void,
): Orchestrator {
  const inbox: InboxEvent[] = [];
  let processing = false;
  let aborted = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let roundsThisMinute = 0;

  setInterval(() => { roundsThisMinute = 0; }, 60000);

  function now() { return new Date().toISOString().slice(11, 19); }

  function saveToWiki(agentId: string, content: string, label: string, taskId?: string): string {
    const dir = sm.get('master')?.wikiDir;
    if (!dir) return '';
    const reportsDir = taskId ? resolve(dir, 'reports', taskId) : resolve(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const filename = `${new Date().toISOString().slice(0, 10)}-${agentId}-${Date.now()}.md`;
    const filepath = resolve(reportsDir, filename);
    writeFileSync(filepath, `# ${label}\n\n${content}\n`);
    return filepath;
  }

  function summarize(text: string): string {
    if (text.length <= MAX_SUMMARY_LEN) return text;
    return text.slice(0, MAX_SUMMARY_LEN) + '...';
  }

  function scheduleWake() {
    if (processing) return;
    if (inbox.length === 0) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => wakeMaster(), DEBOUNCE_MS);
  }

  async function wakeMaster() {
    if (processing || inbox.length === 0) return;
    const master = sm.get('master');
    if (!master || master.status !== 'idle') return;

    if (roundsThisMinute >= MAX_ROUNDS_PER_MIN) {
      onEvent('system', { type: 'text', content: '⚠️ Master rate limited, pausing 10s...' });
      await new Promise(r => setTimeout(r, 10000));
      roundsThisMinute = 0;
    }

    processing = true;
    roundsThisMinute++;
    aborted = false;

    const events = inbox.splice(0);
    const images = events.filter(e => e.image).map(e => e.image!);
    if (images.length) logger.info('Orchestrator: passing images to master', { count: images.length });

    // Build prompt
    const workers = sm.getAll().filter(s => s.config.role === 'worker');
    const statusLines = workers.map(w => `- ${w.config.name} (${w.config.id}): ${w.status}`).join('\n');
    const eventLines = events.map(e => `[${e.timestamp}] ${e.from}${e.taskId ? ` (task:${e.taskId})` : ''}: ${e.summary}${e.savedTo ? ` (full: ${e.savedTo})` : ''}${e.image ? ' [+image]' : ''}`).join('\n');

    // Active tasks summary
    const activeTasks = taskStore.getActive();
    const taskLines = activeTasks.length
      ? activeTasks.map(t => {
          const done = t.stages.filter(s => s.status === 'done').length;
          const current = t.stages.find(s => s.status !== 'done');
          const waitNote = t.status === 'waiting' ? ` ⚠️ WAITING FOR USER: ${t.waitingFor}` : '';
          const emptyNote = t.stages.length === 0 ? ' (no steps yet — use TASK_ADD_STAGE to add steps)' : '';
          return `- ${t.id} "${t.name}" (${done}/${t.stages.length}${current ? ', ' + current.status : ''})${waitNote}${emptyNote}`;
        }).join('\n')
      : '(none)';

    const prompt = `[Active Tasks]\n${taskLines}\n\n[Worker Status]\n${statusLines}\n\n[New Events - ${events.length}]\n${eventLines}\n\n[Rules]\n1. Reply to user: write directly\n2. Multi-step work: TASK_CREATE name: <name>\\nSTAGE: <s1>\\nSTAGE: <s2>\n3. Dispatch for task: DISPATCH worker-id [task:<id>, stage:<N>]: instructions\n4. Stage needs user input: TASK_WAIT <task-id>: reason [BUTTON1] [BUTTON2]\n5. Stage done: TASK_UPDATE <task-id>: stage <N> → done\n6. All stages done: TASK_DONE <task-id>\n7. Simple one-shot (no task): DISPATCH worker-id: instructions\n8. All done: end with DONE\n9. Use [task:latest] to reference a task you just created in this response.`;

    try {
      const response = await sm.sendPrompt('master', prompt, onEvent, images.length ? images : undefined);
      if (aborted) { processing = false; return; }

      // Parse task commands
      const cmds = parseTaskCommands(response);
      let latestTaskId: string | undefined;

      // Scope enforcement: if user spoke in a specific task context,
      // only allow operations on that task. User intent takes priority.
      const userTaskIds = events.filter(e => e.from === 'user' && e.taskId).map(e => e.taskId!);
      const scopeTaskId = userTaskIds.length > 0 ? userTaskIds[0] : undefined;

      for (const cmd of cmds) {
        // Resolve task ID
        let cmdTaskId = 'taskId' in cmd ? cmd.taskId : undefined;
        if (cmdTaskId === 'latest') cmdTaskId = latestTaskId;

        // Scope guard: if we have a scope, block operations on other tasks
        // Exception: newly created tasks (latestTaskId) are always allowed
        if (scopeTaskId && cmdTaskId && cmdTaskId !== scopeTaskId && cmdTaskId !== latestTaskId && cmd.type !== 'create') {
          logger.info('Scope guard: blocked cross-task operation', { scope: scopeTaskId, target: cmdTaskId, type: cmd.type });
          continue;
        }

        switch (cmd.type) {
          case 'create': {
            const task = taskStore.create(cmd.name, cmd.stages);
            latestTaskId = task.id;
            onBroadcastTasks();
            break;
          }
          case 'update':
            taskStore.updateStage(cmdTaskId!, cmd.stageIndex, cmd.status as any);
            onBroadcastTasks();
            break;
          case 'wait':
            taskStore.setWaiting(cmdTaskId!, cmd.reason, cmd.actions);
            onBroadcastTasks();
            break;
          case 'done':
            // Don't auto-complete — ask user to confirm
            taskStore.setWaiting(cmdTaskId!, 'Task ready to close. Confirm?', ['COMPLETE', 'CONTINUE']);
            onBroadcastTasks();
            break;
          case 'add_stage':
            taskStore.addStage(cmdTaskId!, cmd.name);
            onBroadcastTasks();
            break;
          case 'dispatch': {
            const taskId = cmd.taskId === 'latest' ? latestTaskId : cmd.taskId;
            // Scope guard for dispatch — but allow newly created tasks
            if (scopeTaskId && taskId && taskId !== scopeTaskId && taskId !== latestTaskId) {
              logger.info('Scope guard: blocked cross-task dispatch', { scope: scopeTaskId, target: taskId });
              break;
            }
            const worker = sm.get(cmd.workerId);
            if (worker && worker.status === 'idle') {
              if (taskId && cmd.stageIndex !== undefined) {
                taskStore.updateStage(taskId, cmd.stageIndex, 'running', undefined, cmd.workerId);
                onBroadcastTasks();
              }
              executeWorker(cmd.workerId, cmd.instructions, taskId, cmd.stageIndex);
            }
            break;
          }
        }
      }
    } catch (err) {
      if (!aborted) onEvent('system', { type: 'text', content: `❌ Master error: ${(err as Error).message}` });
    }

    processing = false;
    onBroadcastSessions();

    if (inbox.length > 0 && !aborted) scheduleWake();
  }

  async function executeWorker(workerId: string, instructions: string, taskId?: string, stageIndex?: number) {
    onEvent(workerId, { type: 'text', content: `📋 Task from Master:\n${instructions}` });
    onBroadcastSessions();
    try {
      const result = await sm.sendPrompt(workerId, instructions, onEvent);
      const worker = sm.get(workerId);
      const name = worker?.config.name ?? workerId;

      // Update task stage if applicable
      if (taskId && stageIndex !== undefined) {
        taskStore.updateStage(taskId, stageIndex, 'done', summarize(result));
        onBroadcastTasks();
      }

      // Save long results to wiki
      let summary = summarize(result);
      let savedTo: string | undefined;
      if (result.length > MAX_SUMMARY_LEN) {
        savedTo = saveToWiki(workerId, result, `${name} report`, taskId);
      }

      inbox.push({ timestamp: now(), from: name, summary, savedTo, taskId });
      scheduleWake();
    } catch (err) {
      if (taskId && stageIndex !== undefined) {
        taskStore.updateStage(taskId, stageIndex, 'failed', (err as Error).message);
        onBroadcastTasks();
      }
      inbox.push({ timestamp: now(), from: workerId, summary: `❌ Error: ${(err as Error).message}`, taskId });
      scheduleWake();
    }
    onBroadcastSessions();
  }

  return {
    pushUserMessage(text: string, image?: { media_type: string; data: string }, taskId?: string) {
      inbox.push({ timestamp: now(), from: 'user', summary: text, image, taskId });
      scheduleWake();
    },

    pushWorkerReport(workerId: string, workerName: string, text: string) {
      let summary = summarize(text);
      let savedTo: string | undefined;
      if (text.length > MAX_SUMMARY_LEN) {
        savedTo = saveToWiki(workerId, text, `${workerName} report`);
      }
      inbox.push({ timestamp: now(), from: workerName, summary, savedTo });
      scheduleWake();
    },

    abort() {
      aborted = true;
      inbox.length = 0;
      sm.get('master')?.backend?.cancel();
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    },
  };
}
