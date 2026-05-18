/**
 * Task Store — CRUD + persistence for tasks/stages.
 * AI never writes this file directly. Only this module does.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';

export interface Stage {
  name: string;
  status: 'pending' | 'running' | 'waiting_user' | 'done' | 'failed';
  assignedTo?: string;
  result?: string;
}

export interface Task {
  id: string;
  name: string;
  status: 'active' | 'waiting' | 'archived';
  cwd?: string;
  createdAt: string;
  updatedAt: string;
  stages: Stage[];
  waitingFor?: string | null;
  waitingActions?: string[];
}

export interface TaskStore {
  getAll(): Task[];
  getActive(): Task[];
  getArchived(): Task[];
  get(id: string): Task | undefined;
  create(name: string, stageNames: string[], cwd?: string): Task;
  updateStage(taskId: string, stageIndex: number, status: Stage['status'], result?: string, assignedTo?: string): void;
  setWaiting(taskId: string, reason: string, actions?: string[]): void;
  resumeTask(taskId: string): void;
  complete(taskId: string): void;
  addStage(taskId: string, name: string): void;
  delete(taskId: string): void;
  reopen(taskId: string): void;
}

export function createTaskStore(wikisDir: string): TaskStore {
  const filePath = resolve(wikisDir, 'projects.json');
  let tasks: Task[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Load existing data
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    tasks = data.tasks || [];
  } catch { /* file doesn't exist or corrupted — start fresh */ }

  // Crash recovery: reset orphaned "running" stages
  for (const t of tasks) {
    for (const s of t.stages) {
      if (s.status === 'running') {
        s.status = 'pending';
        s.assignedTo = undefined;
      }
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(wikisDir, { recursive: true });
        writeFileSync(filePath, JSON.stringify({ tasks }, null, 2));
      } catch (e) { logger.error('Failed to save tasks', { error: (e as Error).message }); }
    }, 500);
  }

  function now() { return new Date().toISOString(); }

  function touch(task: Task) { task.updatedAt = now(); scheduleSave(); }

  return {
    getAll: () => tasks,
    getActive: () => tasks.filter(t => t.status === 'active' || t.status === 'waiting'),
    getArchived: () => tasks.filter(t => t.status === 'archived'),
    get: (id) => tasks.find(t => t.id === id),

    create(name, stageNames, cwd) {
      const task: Task = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        status: 'active',
        cwd,
        createdAt: now(),
        updatedAt: now(),
        stages: stageNames.map(s => ({ name: s, status: 'pending' as const })),
        waitingFor: null,
      };
      tasks.push(task);
      scheduleSave();
      logger.info('Task created', { id: task.id, name });
      return task;
    },

    updateStage(taskId, stageIndex, status, result, assignedTo) {
      const task = tasks.find(t => t.id === taskId);
      if (!task || !task.stages[stageIndex]) return;
      task.stages[stageIndex].status = status;
      if (result != null) task.stages[stageIndex].result = result.length > 300 ? result.slice(0, 300) + '...' : result;
      if (assignedTo) task.stages[stageIndex].assignedTo = assignedTo;
      touch(task);
    },

    setWaiting(taskId, reason, actions) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'waiting';
      task.waitingFor = reason;
      task.waitingActions = actions;
      touch(task);
    },

    resumeTask(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'active';
      task.waitingFor = null;
      task.waitingActions = undefined;
      touch(task);
    },

    complete(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'archived';
      touch(task);
      logger.info('Task completed', { id: taskId, name: task.name });
    },

    addStage(taskId, name) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.stages.push({ name, status: 'pending' });
      if (task.status === 'archived') task.status = 'active';
      touch(task);
    },

    delete(taskId) {
      tasks = tasks.filter(t => t.id !== taskId);
      scheduleSave();
    },

    reopen(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'active';
      task.waitingFor = null;
      task.waitingActions = undefined;
      // If all stages are done and no pending Continue stage exists, add one
      if (task.stages.every(s => s.status === 'done') && !task.stages.some(s => s.name.includes('reopened'))) {
        task.stages.push({ name: 'Continue (reopened by user)', status: 'pending' });
      }
      touch(task);
    },
  };
}
