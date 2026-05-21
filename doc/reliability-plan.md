# Reliability Plan — Dispatch ACK + Heartbeat

## Problem

Two failure modes where tasks get stuck:

1. **Dispatch fails silently** — Worker not available (stopped/busy), server knows but Master doesn't
2. **Dispatch not parsed** — Master's format is wrong, server doesn't parse it, nobody knows

## Solution

### Part 1: Dispatch ACK (immediate notification)

**When:** Server parses a DISPATCH command but worker is unavailable.

**Where:** `src/orchestrator.ts`, inside the dispatch case.

```ts
case 'dispatch': {
  const worker = sm.get(cmd.workerId);
  if (!worker || worker.status !== 'idle') {
    // ACK failure — notify Master immediately
    inbox.push({
      timestamp: now(),
      from: 'system',
      summary: `⚠️ DISPATCH failed: ${cmd.workerId} is ${worker?.status ?? 'not found'}. Please reassign.`,
      taskId
    });
    scheduleWake();
    break;
  }
  // ... normal dispatch ...
}
```

**Effect:** Master wakes up next round, sees the failure, reassigns to another worker.

### Part 2: Heartbeat (periodic check)

**When:** Every N minutes, if there are active tasks with pending stages and idle workers.

**Where:** `src/orchestrator.ts`, new setInterval.

```ts
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
  // Only trigger if:
  // 1. There are active tasks with pending/running stages
  // 2. There are idle workers available
  // 3. Master is idle (not already processing)
  // 4. Inbox is empty (no other events pending)
  const hasWork = taskStore.getActive().some(t =>
    t.stages.some(s => s.status === 'pending' || s.status === 'running')
  );
  const hasIdleWorker = sm.getAll().some(s => s.config.role === 'worker' && s.status === 'idle');
  const masterIdle = sm.get('master')?.status === 'idle';

  if (hasWork && hasIdleWorker && masterIdle && inbox.length === 0 && !processing) {
    inbox.push({ timestamp: now(), from: 'system', summary: 'Heartbeat: active tasks have pending stages. Check progress and dispatch if needed.' });
    scheduleWake();
  }
}, HEARTBEAT_INTERVAL);
```

**Conditions (all must be true):**
- Active tasks have pending or running stages
- At least one worker is idle
- Master is idle
- Inbox is empty (don't interrupt ongoing work)
- Not already processing

**Effect:** Master wakes up, sees `[Active Tasks]` with pending stages + idle workers → dispatches. If everything is fine (stages are running with workers), it just says DONE.

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
