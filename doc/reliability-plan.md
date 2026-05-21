# Reliability Plan — Dispatch ACK + Heartbeat

## Problem

Two failure modes where tasks get stuck:

1. **Dispatch fails silently** — Worker not available (stopped/busy), server knows but Master doesn't
2. **Dispatch not parsed** — Master's format is wrong, server doesn't parse it, nobody knows

## Solution

### Part 1: Dispatch ACK (immediate notification)

**When:** Server parses a DISPATCH command but worker is unavailable.

**Where:** `src/orchestrator.ts`, inside the dispatch case, AFTER scope guard.

```ts
case 'dispatch': {
  const taskId = cmd.taskId === 'latest' ? latestTaskId : cmd.taskId;

  // 1. Scope guard first — blocked dispatches are intentional, not failures
  if (scopeTaskId && taskId && taskId !== scopeTaskId && taskId !== latestTaskId) {
    logger.info('Scope guard: blocked cross-task dispatch', { scope: scopeTaskId, target: taskId });
    break;
  }

  // 2. Check worker availability
  const worker = sm.get(cmd.workerId);
  if (worker && worker.status === 'idle') {
    // Normal dispatch...
    if (taskId && cmd.stageIndex !== undefined) {
      taskStore.updateStage(taskId, cmd.stageIndex, 'running', undefined, cmd.workerId);
      onBroadcastTasks();
    }
    executeWorker(cmd.workerId, cmd.instructions, taskId, cmd.stageIndex);
  } else {
    // 3. ACK failure — only here (not when scope guard blocks)
    inbox.push({
      timestamp: now(),
      from: 'system',
      summary: `⚠️ DISPATCH failed: ${cmd.workerId} is ${worker?.status ?? 'not found'}. Please reassign.`,
      taskId
    });
    scheduleWake();
  }
  break;
}
```

**Effect:** Master wakes up next round, sees the failure, reassigns to another worker.

### Part 2: Heartbeat (periodic check)

**When:** Every N minutes, checks for two distinct situations.

**Where:** `src/orchestrator.ts`, new setInterval.

```ts
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  const master = sm.get('master');
  const masterIdle = master?.status === 'idle';
  if (!masterIdle || inbox.length > 0 || processing) return; // System busy, skip

  const hasIdleWorker = sm.getAll().some(s => s.config.role === 'worker' && s.status === 'idle');

  const needsAttention = taskStore.getActive().some(t =>
    t.stages.some(s => {
      // Situation A: Pending task + idle worker available = dispatch was missed
      if (s.status === 'pending' && hasIdleWorker) return true;

      // Situation B: Running task but worker not actually working (Method C)
      // Triggers regardless of hasIdleWorker — Master needs to know even if no worker is free
      if (s.status === 'running' && s.assignedTo) {
        const w = sm.get(s.assignedTo);
        return !w || w.status !== 'working'; // Worker gone or not working = stuck
      }

      return false;
    })
  );

  if (needsAttention) {
    inbox.push({
      timestamp: now(),
      from: 'system',
      summary: 'Heartbeat: Found pending tasks with available workers, OR running tasks that appear stuck. Please check status and dispatch.'
    });
    scheduleWake();
  }
}, HEARTBEAT_INTERVAL);
```

**Two situations handled:**

| Situation | Condition | hasIdleWorker required? | Why |
|---|---|---|---|
| A. Missed dispatch | stage pending | ✅ Yes | No point waking Master if no worker can take it |
| B. Stuck execution | stage running + worker not working | ❌ No | Master needs to know even if all workers are dead |

### Part 3: Don't heartbeat when waiting for user

**Already handled:** Tasks in `waiting` status have stages marked `waiting_user`, not `pending` or `running`. The heartbeat condition checks for `pending` or `running` stages only.

| Task status | Stage status | Heartbeat triggers? |
|---|---|---|
| active | pending (not yet dispatched) | ✅ Yes |
| active | running (worker doing it) | ✅ Yes (in case worker died) |
| waiting | waiting_user | ❌ No |
| archived | done | ❌ No |

### Configuration

| Setting | Default | Notes |
|---|---|---|
| HEARTBEAT_INTERVAL | 5 minutes | Adjustable. OpenClaw uses 30 min but we're local (no token cost concern) |
| Disable heartbeat | Set interval to 0 | For testing or when not needed |

### Token cost

Each heartbeat = 1 Master prompt (~500 tokens input + ~100 tokens output if nothing to do).
Every 5 min = 12/hour = ~7,200 tokens/hour when idle with pending tasks.
Negligible for local use.

## Implementation Order

1. **Dispatch ACK** — add to orchestrator dispatch case (5 lines)
2. **Heartbeat interval** — add setInterval to orchestrator (15 lines)
3. **Test** — start agents, give a task, stop worker mid-task, verify Master gets notified and reassigns

## Not doing

- ❌ Heartbeat when all tasks are waiting_user
- ❌ Heartbeat when no active tasks
- ❌ Heartbeat when Master is busy
- ❌ Killing/restarting workers automatically (Master decides)

---

## Future Enhancement: C+ Zombie Detection (In-Memory Heartbeat)

### Problem with basic approach (Method C)

Method C checks: `stage running + worker idle = stuck`. This covers 95% of cases.

But there's a blind spot: **Zombie Worker** — worker status is `working` but it's actually hung (API timeout, infinite loop, dead lock). System thinks "it's still working, don't disturb" → task stuck forever.

### Solution: Track last activity time in memory

**Where:** SessionManager or Orchestrator (in-memory only, no disk I/O)

**How:** Every time a streaming event comes from a worker (text chunk, tool_call, tool_done), update `lastActivity`:

```ts
// In onEvent or the streaming callback:
if (agentId.startsWith('worker')) {
  workerLastActivity[agentId] = Date.now();
}
```

**Heartbeat check becomes:**

```ts
const assignedWorker = sm.get(stage.assignedTo);
const isWorkerMissingOrIdle = !assignedWorker || assignedWorker.status === 'idle';
const isWorkerZombie = assignedWorker?.status === 'working' 
  && (Date.now() - (workerLastActivity[stage.assignedTo] ?? 0) > STALE_THRESHOLD);

if (isWorkerMissingOrIdle || isWorkerZombie) {
  // Stale — trigger heartbeat
}
```

**STALE_THRESHOLD:** 15 minutes (if no streaming event for 15 min while status is `working`, it's likely hung)

### When to implement

- **Now (local single-user):** Method C is sufficient. If worker hangs, user notices and clicks stop.
- **Later (server/unattended):** Add C+ to catch zombie workers automatically.

### Cost

- Zero disk I/O (memory only)
- One `Date.now()` per streaming event (negligible)
- Lost on server restart (but crash recovery resets running → pending anyway)

