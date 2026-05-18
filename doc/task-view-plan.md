# Task View — Implementation Plan

## Overview

Add a "Task View" to Kiro Orchestra that lets users manage multiple concurrent tasks with stages, status tracking, and per-task conversations. Tasks are created automatically by Master or manually by the user.

---

## Current State

- UI has: Sidebar (channels) | Chat | Activity Panel (tool calls)
- Master dispatches work to workers via `DISPATCH worker-id: task`
- No concept of "task" as a persistent entity — everything is one-shot chat
- No way to track multi-step work across time
- No way to pause/resume or switch between concurrent work items

## Target State

- UI has two modes: **Chat Mode** (existing) and **Task Mode** (new)
- Tasks are persistent objects with stages, stored in `wikis/projects.json`
- Master uses structured commands (`TASK_CREATE`, `TASK_UPDATE`, etc.) to manage tasks
- Server parses commands and updates the JSON file (AI never writes JSON directly)
- User can switch between tasks, approve/reject, archive completed ones

---

## Data Model

### File: `wikis/projects.json`

```json
{
  "tasks": [
    {
      "id": "task-1716000000",
      "name": "Partner Emails",
      "status": "active",
      "cwd": "AP26 AWS Sales Planning",
      "currentStage": 2,
      "createdAt": "2026-05-18T08:00:00Z",
      "updatedAt": "2026-05-18T08:30:00Z",
      "stages": [
        { "name": "查詢 OPP 資料", "status": "done", "result": "Found 5 OPPs" },
        { "name": "草擬 email", "status": "running", "assignedTo": "worker-1" },
        { "name": "User review", "status": "pending" },
        { "name": "發送 emails", "status": "pending" },
        { "name": "更新 SFDC", "status": "pending" }
      ],
      "waitingFor": null
    }
  ]
}
```

### Stage status values
- `pending` — not started
- `running` — worker is executing
- `waiting_user` — blocked, needs user input
- `done` — completed
- `failed` — error occurred

### Task status values
- `active` — has pending/running stages
- `waiting` — blocked on user input
- `archived` — all stages done, moved to archive

---

## Master Command Protocol

Master communicates task state changes via structured text commands in its response. Server parses these with regex — Master never writes JSON.

### Commands

| Command | Format | Example |
|---------|--------|---------|
| Create task | `TASK_CREATE name: <name>\nSTAGE: <s1>\nSTAGE: <s2>\n...` | `TASK_CREATE name: Partner Emails\nSTAGE: Query OPPs\nSTAGE: Draft emails` |
| Update stage | `TASK_UPDATE <task-id>: stage <n> → <status>` | `TASK_UPDATE task-1716000000: stage 2 → done` |
| Wait for user | `TASK_WAIT <task-id>: <reason>` | `TASK_WAIT task-1716000000: Please review the 5 email drafts` |
| Complete task | `TASK_DONE <task-id>` | `TASK_DONE task-1716000000` |
| Dispatch with context | `DISPATCH <worker-id> [task:<task-id>, stage:<n>]: <instructions>` | `DISPATCH worker-1 [task:task-123, stage:2]: Write email drafts` |

### Parsing rules (Server-side)
- Commands are parsed AFTER the full Master response is received
- Multiple commands can appear in one response
- Unknown/malformed commands are silently ignored (never crash)
- DISPATCH with `[task:..., stage:...]` updates that stage to `running`

---

## Implementation Steps

### Step 1: Task Store (Server-side)

**File: `src/taskStore.ts`** (new)

Purpose: CRUD operations on `wikis/projects.json`. Pure data layer, no AI logic.

```ts
interface Stage {
  name: string;
  status: 'pending' | 'running' | 'waiting_user' | 'done' | 'failed';
  assignedTo?: string;
  result?: string;
}

interface Task {
  id: string;
  name: string;
  status: 'active' | 'waiting' | 'archived';
  cwd?: string;
  currentStage: number;
  createdAt: string;
  updatedAt: string;
  stages: Stage[];
  waitingFor?: string | null;
}

interface TaskStore {
  getAll(): Task[];
  getActive(): Task[];
  getArchived(): Task[];
  get(id: string): Task | undefined;
  create(name: string, stages: string[], cwd?: string): Task;
  updateStage(taskId: string, stageIndex: number, status: Stage['status'], result?: string): void;
  setWaiting(taskId: string, reason: string): void;
  complete(taskId: string): void;
  archive(taskId: string): void;
  save(): void;  // write to disk
}
```

Implementation:
- Load from `wikis/projects.json` on construction (try/catch, default to empty)
- Write atomically: write `.tmp` then rename
- Expose methods for each operation
- `save()` called after every mutation

### Step 2: Command Parser (Server-side)

**File: `src/taskCommandParser.ts`** (new)

Purpose: Parse Master's response text and extract task commands.

```ts
interface TaskCommand =
  | { type: 'create'; name: string; stages: string[] }
  | { type: 'update'; taskId: string; stageIndex: number; status: string }
  | { type: 'wait'; taskId: string; reason: string }
  | { type: 'done'; taskId: string }
  | { type: 'dispatch'; workerId: string; taskId: string; stageIndex: number; instructions: string }

function parseTaskCommands(response: string): TaskCommand[];
```

Regex patterns:
- `TASK_CREATE name: (.+)\n((?:STAGE: .+\n?)+)` → extract name + stages
- `TASK_UPDATE ([\w-]+): stage (\d+) → (\w+)` → extract taskId, index, status
- `TASK_WAIT ([\w-]+): (.+)` → extract taskId, reason
- `TASK_DONE ([\w-]+)` → extract taskId
- `DISPATCH ([\w-]+) \[task:([\w-]+), stage:(\d+)\]: ([\s\S]+?)(?=\nDISPATCH|\nTASK_|\nDONE|$)` → extract all

### Step 3: Orchestrator Integration

**File: `src/orchestrator.ts`** (modify)

Changes:
1. Import TaskStore and TaskCommandParser
2. In `wakeMaster()` prompt, add `[Active Tasks]` section:
   ```
   [Active Tasks]
   - task-123 "Partner Emails" (stage 2/5 running, assigned: worker-1)
   - task-456 "SFDC Hygiene" (stage 1/3 waiting user)
   ```
3. After Master responds, parse task commands:
   ```ts
   const cmds = parseTaskCommands(response);
   for (const cmd of cmds) {
     switch (cmd.type) {
       case 'create': taskStore.create(cmd.name, cmd.stages); break;
       case 'update': taskStore.updateStage(cmd.taskId, cmd.stageIndex, cmd.status); break;
       case 'wait': taskStore.setWaiting(cmd.taskId, cmd.reason); break;
       case 'done': taskStore.complete(cmd.taskId); break;
       case 'dispatch': /* update stage + dispatch worker */ break;
     }
     broadcastTasks();
   }
   ```
4. DISPATCH parsing: if dispatch has `[task:..., stage:...]`, update that stage to `running` and pass task context to worker

### Step 4: WebSocket Protocol (Server-side)

**File: `src/wsServer.ts`** (modify)

New message types:

```ts
// Server → Client
| { type: 'tasks'; tasks: Task[] }

// Client → Server
| { type: 'task_select'; taskId: string }       // user clicks a task
| { type: 'task_respond'; taskId: string; content: string }  // user replies in task context
| { type: 'task_archive'; taskId: string }      // user archives
| { type: 'task_create'; name: string }         // user manually creates (Master will plan stages)
```

Changes:
- On connection: send `tasks` message (like `sessions`)
- `broadcastTasks()` function: broadcast current task list to all clients
- Handle new client message types
- `task_respond`: push to orchestrator inbox with task context
- `task_create`: push to orchestrator inbox as "User wants to create task: <name>"

### Step 5: Frontend — Task Mode UI

**File: `public/index.html`** (modify)

Layout changes:
- Sidebar gets two tabs: `[Chat]` `[Tasks]`
- When Tasks tab active:
  - Sidebar shows task list (active on top, archived below)
  - Main area shows selected task's conversation
  - Right panel shows selected task's stages (replaces Activity)
- When Chat tab active:
  - Everything works as before (channels, activity panel)

New UI components:

**Task List (sidebar, when Tasks tab active):**
```html
<div class="task-item active" data-id="task-123">
  <div class="task-name">Partner Emails</div>
  <div class="task-status">⏸ waiting approval</div>
  <div class="task-progress">██████░░░░ 3/5</div>
</div>
```

**Stage Panel (right side, when task selected):**
```html
<div class="stage done">✅ 1. Query OPPs</div>
<div class="stage running">⏳ 2. Draft emails</div>
<div class="stage waiting">⏸ 3. User review</div>
<div class="stage pending">○ 4. Send emails</div>
```

**Task conversation (main area):**
- Shows only messages related to this task (filtered by task ID)
- Input box sends `task_respond` instead of `user_message`

**New Task button:**
- Shows input field: "Describe what you want to accomplish"
- Sends `task_create` → Master plans stages → task appears in list

### Step 6: Master Persona Update

**File: `src/index.ts`** (modify)

Add to Master persona:
```
Task Management:
- When user gives a multi-step request, create a task: TASK_CREATE name: <name>\nSTAGE: ...\nSTAGE: ...
- When dispatching work for a task: DISPATCH worker-id [task:<id>, stage:<n>]: instructions
- When a stage needs user input: TASK_WAIT <task-id>: reason
- When a stage completes: TASK_UPDATE <task-id>: stage <n> → done
- When all stages done: TASK_DONE <task-id>
- For simple one-shot requests (no multi-step), don't create a task — just DISPATCH directly.
```

### Step 7: Task Conversation Storage

**File: `src/taskStore.ts`** (extend)

Each task gets its own conversation log:
- Stored in `wikis/master/tasks/<task-id>.jsonl` (one JSON object per line)
- Appended on every message related to that task
- Read when user selects a task (replay to UI)
- Format: `{"timestamp":"...","from":"user|master|worker-1","content":"..."}`

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/taskStore.ts` | NEW | Task CRUD + persistence |
| `src/taskCommandParser.ts` | NEW | Parse Master's task commands |
| `src/orchestrator.ts` | MODIFY | Add task context to prompt, parse commands from response |
| `src/wsServer.ts` | MODIFY | New message types, broadcastTasks |
| `src/index.ts` | MODIFY | Update Master persona with task instructions |
| `public/index.html` | MODIFY | Add Tasks tab, task list, stage panel, task conversation |
| `wikis/projects.json` | AUTO-CREATED | Task data (gitignored) |

---

## Implementation Order

1. **taskStore.ts** — data layer first, can test independently
2. **taskCommandParser.ts** — parser, can test with unit tests
3. **orchestrator.ts** — integrate store + parser
4. **wsServer.ts** — expose to frontend
5. **index.html** — UI last (needs backend ready)
6. **index.ts** — persona update (do alongside step 3)

Estimated effort: ~4-6 hours for a developer familiar with the codebase.

---

## Edge Cases to Handle

| Case | Handling |
|------|----------|
| Master doesn't create a task for simple requests | Fine — works like before (pure DISPATCH) |
| Master creates malformed TASK_CREATE | Ignore, log warning |
| Task ID in DISPATCH doesn't exist | Ignore task context, still dispatch the work |
| User archives a task with running stages | Cancel running workers first |
| Server restart | Load from projects.json, tasks resume from last saved state |
| projects.json corrupted | Start with empty task list, log error |
| Worker timeout on a task stage | Mark stage as failed, notify Master |
| User creates task while Master is busy | Queue in inbox, Master handles next wake |

---

## Not In Scope (Future)

- Drag-and-drop stage reordering
- Task templates / SOP library
- Task dependencies (task B waits for task A)
- Multiple users / permissions
- Task time estimates / deadlines


---

## Code Review Findings (must fix before implementation)

### Issue 1: DISPATCH regex incompatibility

Current DISPATCH regex in `orchestrator.ts`:
```ts
/^DISPATCH\s+([\w-]+):\s*([\s\S]*)/
```
Does NOT match the new task-aware format `DISPATCH worker-1 [task:xxx, stage:2]: ...`.

**Fix:** Replace with a regex that handles both formats:
```ts
/^DISPATCH\s+([\w-]+)(?:\s*\[task:([\w-]+),\s*stage:(\d+)\])?\s*:\s*([\s\S]*)/
```
Groups: 1=workerId, 2=taskId (optional), 3=stageIndex (optional), 4=instructions

### Issue 2: Task ID lifecycle

Master cannot know the task ID in the same turn it creates the task. Two options:

**Option A (recommended):** Master creates task AND dispatches in one response. Server generates ID during TASK_CREATE, then when parsing DISPATCH in the same response, uses the most recently created task ID if DISPATCH references `[task:latest]`.

**Option B:** Two-turn approach. Master creates task → Server pushes "Task created: task-xxx" to inbox → Master wakes again and dispatches with the real ID. Slower but simpler.

### Issue 3: Remove `currentStage` field

Multiple stages can run in parallel. Replace with computed value:
```ts
function getCurrentStage(task: Task): number {
  const firstNonDone = task.stages.findIndex(s => s.status !== 'done');
  return firstNonDone === -1 ? task.stages.length : firstNonDone;
}
```

### Issue 4: Stage index convention

Use **1-based** in Master commands (natural for AI), **0-based** internally.
Parser converts: `stageIndex = parseInt(match) - 1`

Document this clearly in Master persona instructions.

### Issue 5: executeWorker needs task context

```ts
// Current signature:
async function executeWorker(workerId: string, task: string)

// New signature:
async function executeWorker(workerId: string, instructions: string, taskId?: string, stageIndex?: number)
```

On completion:
- If taskId provided → `taskStore.updateStage(taskId, stageIndex, 'done', result)`
- Push to inbox with taskId so Master knows which task progressed

### Issue 6: Task conversation isolation

Add `taskId?: string` to:
- `ServerMsg` (agent_event) — so frontend can filter
- `InboxEvent` — so orchestrator can show task context to Master
- Frontend `logs` — add `taskLogs: Record<string, Entry[]>` separate from channel logs

### Issue 7: Backward compatibility

Explicitly state in orchestrator logic:
```ts
// Parse task commands first (TASK_CREATE, TASK_UPDATE, etc.)
const taskCmds = parseTaskCommands(response);
// Then parse DISPATCH (both task-aware and plain)
const parts = response.split(/^(?=DISPATCH\s)/m);
// Plain DISPATCH (no [task:...]) works exactly as before
```

### Issue 8: Windows atomic write

Don't use rename trick. Just `writeFileSync(path, data)` — it's sufficient for single-process writes. Add error handling:
```ts
save() {
  try { writeFileSync(this.filePath, JSON.stringify({ tasks: this.tasks }, null, 2)); }
  catch (e) { logger.error('Failed to save tasks', { error: e.message }); }
}
```

### Issue 9: task_respond routing

When user sends `task_respond`, orchestrator needs to:
1. Include task context in the inbox event: `[user responding to task "Partner Emails" stage 3]: approved`
2. Master sees this and knows which task to advance
3. If the task was in `waiting` status, change it back to `active`

```ts
// In wsServer.ts handler for task_respond:
case 'task_respond': {
  const task = taskStore.get(msg.taskId);
  if (task && task.status === 'waiting') {
    task.status = 'active';
    task.waitingFor = null;
    taskStore.save();
  }
  orch.pushUserMessage(`[Re: task "${task?.name}" stage ${task?.currentStage}] ${msg.content}`, undefined, msg.taskId);
  broadcastTasks();
  break;
}
```


### Issue 10: Multi-language support

Master and Workers may respond in any language (Chinese, Japanese, English, etc.). This affects:

**Command parsing:** Master might mix languages in its response:
```
好的，我來建立任務。

TASK_CREATE name: Partner Email 跟進
STAGE: 查詢 OPP 資料
STAGE: 草擬 email
STAGE: 等待 user 確認

DISPATCH worker-1 [task:task-123, stage:1]: 請查詢以下 5 個 OPP 的詳細資料...
```

**Rules:**
- Command keywords (`TASK_CREATE`, `STAGE:`, `DISPATCH`, `DONE`) must ALWAYS be English — this is the protocol, not natural language
- Task names, stage names, instructions can be any language
- Regex must handle Unicode in content: use `[\s\S]` not `.` for multi-byte chars (already done)
- `[\w-]` for IDs is fine (IDs are always ASCII)

**UI:**
- All UI labels (buttons, headers) stay English (current state)
- Task names and stage names display whatever language Master chose
- No need for i18n framework — content is dynamic from AI, UI chrome is minimal English

**Persona instruction to add:**
```
- Command keywords (TASK_CREATE, STAGE:, DISPATCH, TASK_UPDATE, TASK_WAIT, TASK_DONE, DONE) must always be in English exactly as shown.
- Task names, stage names, and instructions can be in any language the user prefers.
```

**Test cases to verify:**
- Task name with CJK characters: `TASK_CREATE name: 合作夥伴信件跟進`
- Stage with emoji: `STAGE: 📧 發送確認信`
- DISPATCH with mixed language: `DISPATCH worker-1 [task:task-123, stage:1]: 請查詢 OPP O12883515 的詳細資料`
- Regex must not break on `→` character in TASK_UPDATE (it's UTF-8, not ASCII arrow)


---

## UX Review — User Perspective Issues

### Issue A: User 不知道什麼時候該用 Chat vs Task

User 打開頁面看到兩個 tab：[Chat] [Tasks]。自然的問題是：「我要在哪裡打字？」

**問題：** 如果 user 在 Chat 裡下了一個複雜指令，Master 會自動建 task。但 user 此時在 Chat tab，看不到 task 被建立了。要手動切到 Tasks tab 才能看到。

**建議：** 
- Master 建立 task 後，UI 自動跳到 Tasks tab 並選中新 task
- 或者在 Chat 裡顯示一條通知：「📋 Task created: Partner Emails → [View]」，點 View 跳過去
- 簡單指令（不建 task）就留在 Chat，不跳轉

### Issue B: Task 等待 user 時，user 怎麼知道？

Master 發了 `TASK_WAIT`，task 狀態變成 waiting。但如果 user 在 Chat tab 或看別的 task，不會注意到。

**建議：**
- Sidebar 的 task item 加閃爍/badge：`📋 Partner Emails 🔴` 
- 或者 browser notification（如果 user 允許）
- 至少在 Chat 裡推一條系統訊息：「⏸ Task "Partner Emails" is waiting for your input」

### Issue C: User 如何 approve？

Task 等待 user review 時，user 要做什麼？點進 task → 看到內容 → 然後呢？

**問題：** 文件只說 input box 送 `task_respond`。但 user 可能只想按一個「Approve」按鈕，不想打字。

**建議：**
- `TASK_WAIT` 可以帶 action buttons：`TASK_WAIT task-123: Review drafts [APPROVE] [REJECT] [EDIT]`
- Server 解析 `[...]` 裡的按鈕，UI 顯示可點擊的按鈕
- 點按鈕等同送 `task_respond` with content "APPROVE" / "REJECT"
- 如果沒有按鈕定義，就顯示純文字輸入框

### Issue D: Task 太多時怎麼辦？

如果 user 用了一個月，archived tasks 可能有 50+ 個。Sidebar 會很長。

**建議：**
- Archived 區塊預設折疊，只顯示數量：「✅ Archived (47)」點擊展開
- 或者 archived tasks 不顯示在 sidebar，另開一個 "History" 頁面
- Active tasks 永遠在最上面

### Issue E: User 手動建 task 的流程不直覺

點 [+ New Task] → 出現輸入框 → 打描述 → Master 拆 stages → task 出現。

**問題：** 中間有延遲（Master 要思考 + 回應），user 不知道在等什麼。

**建議：**
- 點 [+ New Task] 後立刻顯示一個 placeholder task：「⏳ Planning...」
- Master 回應後替換成真正的 task + stages
- 如果 Master 判斷不需要建 task（太簡單），placeholder 消失，改在 Chat 裡直接回應

### Issue F: Stage 進度看不到細節

右側 Stage panel 只顯示 `✅ 1. Query OPPs`。User 可能想知道：查到了什麼？結果是什麼？

**建議：**
- 點擊 stage 可以展開看 `result` 欄位的內容
- Running 的 stage 顯示 worker 的即時輸出（streaming）
- Done 的 stage 顯示摘要（從 `result` 欄位）

### Issue G: Chat 和 Task 的訊息重複

User 在 Chat 裡說「幫我寫 5 封 email」→ Master 建 task → 之後所有對話都在 Task 裡。但 Chat 的 #all channel 還是會看到 Master 的回應（因為 broadcast 是全域的）。

**問題：** 同一段對話出現在兩個地方，混亂。

**建議：**
- Task-related 的 Master 回應，在 Chat #all 裡只顯示一行摘要：「📋 [Partner Emails] Stage 2 dispatched to Worker 1」
- 完整對話只在 Task view 裡看到
- 或者：task 建立後，相關訊息只出現在 Task view，Chat 裡完全不顯示（乾淨分離）

### Issue H: 切換 task 時，右側 panel 的轉換

User 在 Chat mode → 右側是 Activity（tool calls）。切到 Tasks mode → 右側變成 Stages。

**問題：** 如果 worker 正在跑 tool calls，切到 Tasks mode 就看不到了。

**建議：**
- Tasks mode 的右側 panel 分兩區：上面是 Stages，下面是 Activity（小一點）
- 或者 Activity 變成底部的一條 status bar：「⏳ Worker 1: get_opportunity_details」

---

### Summary: Priority fixes for good UX

| Priority | Issue | Fix |
|----------|-------|-----|
| P0 | B — User 不知道 task 在等他 | 通知 + badge |
| P0 | C — Approve 要能一鍵按 | Action buttons in TASK_WAIT |
| P1 | A — 不知道用 Chat 還是 Task | 自動跳轉 + 通知 |
| P1 | E — 建 task 時的等待感 | Placeholder |
| P2 | G — 訊息重複 | Task 訊息不出現在 Chat |
| P2 | D — Archived 太多 | 折疊 |
| P3 | F — Stage 細節 | 可展開 |
| P3 | H — Panel 切換 | 合併顯示 |


---

## Implementation Detail: Action Buttons (Issue C)

### Master command format
```
TASK_WAIT task-123: Please review the 5 email drafts [APPROVE] [REJECT] [EDIT]
```

### Server parsing (in `taskCommandParser.ts`)
```ts
// Regex for TASK_WAIT with optional buttons
const waitMatch = line.match(/^TASK_WAIT\s+([\w-]+):\s*(.+?)(?:\s*(\[.+\]))?$/);
if (waitMatch) {
  const [, taskId, reason, buttonsRaw] = waitMatch;
  const buttons = buttonsRaw 
    ? buttonsRaw.match(/\[([^\]]+)\]/g)?.map(b => b.slice(1, -1)) 
    : undefined;
  // buttons = ['APPROVE', 'REJECT', 'EDIT'] or undefined
}
```

### Data model addition
```ts
interface Task {
  // ... existing fields ...
  waitingFor?: string | null;   // reason text
  waitingActions?: string[];    // ['APPROVE', 'REJECT', 'EDIT'] or undefined
}
```

### Frontend rendering
```html
<!-- When task.waitingActions exists -->
<div class="task-actions">
  <span class="wait-reason">Please review the 5 email drafts</span>
  <button onclick="taskRespond('task-123', 'APPROVE')">✅ APPROVE</button>
  <button onclick="taskRespond('task-123', 'REJECT')">❌ REJECT</button>
  <button onclick="taskRespond('task-123', 'EDIT')">✏️ EDIT</button>
</div>

<!-- When no waitingActions, show text input -->
<form onsubmit="taskRespond('task-123', input.value)">
  <input placeholder="Type your response..." />
</form>
```

### Button click handler
```js
function taskRespond(taskId, content) {
  send({ type: 'task_respond', taskId, content });
}
```

### Server handling (wsServer.ts)
```ts
case 'task_respond': {
  const task = taskStore.get(msg.taskId);
  if (task) {
    task.status = 'active';
    task.waitingFor = null;
    task.waitingActions = undefined;
    taskStore.save();
  }
  // Push to orchestrator with context
  orch.pushUserMessage(
    `[Task "${task?.name}"] User responded: ${msg.content}`,
    undefined,
    msg.taskId
  );
  broadcastTasks();
  break;
}
```

This gives the user one-click approve/reject without typing, while still allowing free-text input when no buttons are defined.


---

## Data Risk Analysis

### Risk 1: projects.json grows unbounded

**Problem:** Archived tasks never get deleted. After months of use:
- 500 tasks × 10 stages × ~200 bytes each = ~1MB JSON file
- Every `save()` rewrites the entire file
- Every `broadcastTasks()` sends ALL tasks to frontend (including archived)

**Impact:** Slow save, slow page load, large WebSocket messages.

**Fix:**
- Separate active and archived: `wikis/projects.json` (active only) + `wikis/projects-archive.json` (completed)
- Or: only keep last 50 archived tasks in memory, older ones only on disk
- `broadcastTasks()` only sends active tasks by default; archived loaded on demand
- Max file size guard: if > 2MB, force-archive oldest completed tasks

### Risk 2: Task conversation logs (.jsonl) grow forever

**Problem:** Each task gets `wikis/master/tasks/<task-id>.jsonl`. A long-running task with many back-and-forth messages could be 100KB+. Over time, hundreds of these files accumulate.

**Impact:** Disk space, slow directory listing.

**Fix:**
- Auto-delete conversation logs for archived tasks older than 30 days
- Or: cap each .jsonl at 200 lines (oldest lines dropped)
- On server start, don't load all conversation files — only load when user selects a task

### Risk 3: Concurrent write corruption

**Problem:** Multiple events can trigger `taskStore.save()` nearly simultaneously:
- Worker 1 completes → updateStage → save()
- Worker 2 completes → updateStage → save()
- Both happen within milliseconds

**Impact:** Second write might overwrite first write's changes (read-modify-write race).

**Fix:**
- Use a write queue: mutations update in-memory state immediately, but `save()` is debounced (write at most once per 500ms)
- Or: use a simple mutex/flag: `if (saving) { pendingSave = true; return; }`
```ts
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeFileSync(...); }, 500);
}
```

### Risk 4: Task ID collision

**Problem:** ID is `task-${Date.now()}`. If two tasks are created in the same millisecond (unlikely but possible if Master creates multiple in one response), IDs collide.

**Fix:** Add a counter: `task-${Date.now()}-${counter++}` or use a short random suffix: `task-${Date.now()}-${Math.random().toString(36).slice(2,6)}`

### Risk 5: Orphaned running stages after crash

**Problem:** Server crashes while a worker is executing stage 3. On restart:
- `projects.json` says stage 3 is `running`
- But no worker is actually running (all processes died)
- Task is stuck in `running` forever

**Impact:** Task never progresses, user confused.

**Fix:** On server startup, scan all tasks:
```ts
function recoverStaleStages(tasks: Task[]) {
  for (const task of tasks) {
    for (const stage of task.stages) {
      if (stage.status === 'running') {
        stage.status = 'pending'; // reset to pending, Master will re-dispatch
        stage.assignedTo = undefined;
      }
    }
    if (task.status === 'waiting') { /* keep as-is, user input still needed */ }
  }
}
```

### Risk 6: Master response doesn't contain expected commands

**Problem:** Master is AI — it might:
- Forget to use TASK_CREATE (just starts working without creating a task)
- Use wrong task ID in TASK_UPDATE
- Create duplicate tasks for the same request
- Never send TASK_DONE (task stays active forever)

**Impact:** Data inconsistency, zombie tasks.

**Fix:**
- Wrong task ID → silently ignore (log warning), don't crash
- Duplicate tasks → acceptable (user can archive manually)
- Zombie tasks → add a "stale task" detector: if no activity for 1 hour on an active task, show warning in UI: "⚠️ This task hasn't progressed. [Archive] [Retry]"
- Missing TASK_CREATE → fine, works like before (pure DISPATCH without task tracking)

### Risk 7: Large result field in stages

**Problem:** Worker returns 5000 chars, stored in `stage.result`. With 500 tasks × 10 stages × 5000 chars = 25MB in projects.json.

**Impact:** File too large, slow to parse/save.

**Fix:**
- `result` field capped at 300 chars (same as wiki summary threshold)
- Full result stored in conversation .jsonl file, not in projects.json
- Stage only stores: `result: "Found 5 OPPs matching criteria (see task log for details)"`

### Risk 8: broadcastTasks sends too much data

**Problem:** Every task mutation triggers `broadcastTasks()` which sends ALL tasks to ALL connected clients via WebSocket.

**Impact:** If 20 tasks with 10 stages each, that's ~10KB per broadcast. With frequent updates (every few seconds during active work), bandwidth adds up.

**Fix:**
- Only broadcast changed task: `broadcastTaskUpdate(taskId)` instead of full list
- Or: send delta: `{ type: 'task_update', taskId, changes: {...} }`
- Full task list only sent on initial connection

---

### Summary: Data safeguards to implement

| Safeguard | Where | Implementation |
|-----------|-------|----------------|
| Separate active/archive files | taskStore.ts | Two JSON files |
| Debounced save (500ms) | taskStore.ts | setTimeout queue |
| Result field cap (300 chars) | taskStore.ts | Truncate on write |
| Stale stage recovery on startup | taskStore.ts | Reset `running` → `pending` |
| Task ID with random suffix | taskStore.ts | `task-${Date.now()}-${rand}` |
| Conversation log cap (200 lines) | taskStore.ts | Truncate oldest |
| Broadcast delta not full list | wsServer.ts | `task_update` message type |
| Stale task warning (1hr no activity) | UI | Show warning + action buttons |


---

## Application Security Risk Analysis

### Risk S1: WebSocket has no authentication

**Problem:** Anyone on the same network can connect to `ws://localhost:3000` and:
- Send commands (start/stop agents, dispatch tasks)
- Read all conversations (including sensitive business data)
- Inject messages pretending to be the user

**Impact:** Data leak, unauthorized control of agents.

**Current mitigation:** Runs on localhost only (not exposed to internet).

**Fix (if needed for shared machines):**
- Add a simple token: server generates random token on startup, prints to terminal
- Client must send token on WebSocket connect: `ws://localhost:3000?token=xxx`
- Server rejects connections without valid token
- Token rotates on every server restart

### Risk S2: XSS via AI-generated content

**Problem:** `linkify()` converts AI text to HTML with `<a>` tags. If Master/Worker outputs malicious content like:
```
Check this: [click me](javascript:alert(1))
```
Or if the AI outputs raw HTML that bypasses `esc()`:
```
<img src=x onerror=alert(1)>
```

**Impact:** XSS — arbitrary JS execution in user's browser.

**Current mitigation:** `esc()` runs first (escapes `<>&"`), then `linkify()` only creates `<a>` tags for http/https/file URLs.

**Remaining risk:** The `linkify` regex for markdown links `[text](url)` — if `url` starts with `javascript:` it would create a clickable XSS link.

**Fix:**
```ts
// In linkify(), validate URL protocol before creating <a>
out = out.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, text, url) => {
  if (!/^https?:\/\/|^file:\/\/\//i.test(url)) return `${text} (${url})`; // don't linkify
  return `<a href="${url}" target="_blank">${text}</a>`;
});
```

### Risk S3: Task names/content stored without sanitization

**Problem:** Task names come from AI, stored in `projects.json`, rendered in UI. If task name contains HTML:
```
TASK_CREATE name: <script>alert(1)</script>
```

**Impact:** Stored XSS when task list is rendered.

**Current mitigation:** Frontend uses `esc()` when rendering task names.

**Fix:** Ensure ALL dynamic content from projects.json passes through `esc()` before innerHTML. Never use `innerHTML = task.name` directly. This is already the pattern but must be enforced in the new Task View code.

### Risk S4: Path traversal via task cwd field

**Problem:** If task `cwd` field is set to `../../etc` or `C:\Windows\System32`, workers could read/write sensitive system files.

**Impact:** Arbitrary file access.

**Current mitigation:** kiro-cli itself has tool approval (`--trust-all-tools` bypasses this).

**Fix:**
- Validate cwd in `taskStore.create()`: must be under the WORKSPACE root
- Or: don't allow tasks to set cwd (inherit from agent config)
```ts
function validateCwd(cwd: string, workspaceRoot: string): boolean {
  const resolved = resolve(workspaceRoot, cwd);
  return resolved.startsWith(workspaceRoot);
}
```

### Risk S5: Denial of Service via large WebSocket messages

**Problem:** Client can send a massive `user_message` (e.g., 100MB image base64) that:
- Fills server memory
- Gets written to disk (image save)
- Crashes the process

**Impact:** Server crash, disk fill.

**Fix:**
- Set WebSocket max message size: `new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 })` (10MB limit)
- Validate image size before saving: reject if base64 > 5MB
- Validate text content length: reject if > 100KB

### Risk S6: Command injection via task instructions

**Problem:** Master dispatches to worker: `DISPATCH worker-1: run this command: rm -rf /`
Worker has shell access and `--trust-all-tools` — it will execute anything.

**Impact:** Destructive system commands.

**Current mitigation:** This is by design — agents are trusted. The user chose `--trust-all-tools`.

**Consideration:** This is acceptable for local single-user use. If ever exposed to multiple users or untrusted input, would need sandboxing. Document this as a known limitation.

### Risk S7: Sensitive data in projects.json and conversation logs

**Problem:** Tasks may contain customer names, email addresses, opportunity IDs, financial data. All stored in plaintext in `wikis/` directory.

**Impact:** Data leak if machine is compromised or files are accidentally shared.

**Current mitigation:** `wikis/` is in `.gitignore` (won't be pushed to GitHub).

**Fix:**
- Document clearly: `wikis/` contains sensitive business data, treat like credentials
- Consider: encrypt at rest (overkill for local tool, but note for future)
- On `task_archive`: option to redact sensitive fields

### Risk S8: No rate limiting on WebSocket commands

**Problem:** A malicious or buggy client could spam `start_agent` or `task_create` thousands of times per second.

**Impact:** Fork bomb (spawning hundreds of kiro-cli processes), disk fill (thousands of task files).

**Fix:**
- Rate limit per client: max 10 commands/second, drop excess
- Max agents cap: already limited to ~5, but enforce in code
- Max active tasks cap: e.g., 20 active tasks max
```ts
case 'task_create':
  if (taskStore.getActive().length >= 20) {
    broadcast({ type: 'error', message: 'Max 20 active tasks' });
    break;
  }
```

---

### Summary: Security fixes by priority

| Priority | Risk | Fix | Effort |
|----------|------|-----|--------|
| P0 | S2 — XSS via javascript: links | Validate URL protocol in linkify | 5 min |
| P0 | S5 — DoS via large messages | Set maxPayload on WebSocket | 1 min |
| P1 | S3 — Stored XSS in task names | Enforce esc() on all dynamic content | Review |
| P1 | S8 — No rate limiting | Add command rate limit | 30 min |
| P2 | S1 — No auth on WebSocket | Token-based auth (optional) | 1 hr |
| P2 | S4 — Path traversal via cwd | Validate against workspace root | 15 min |
| P3 | S7 — Sensitive data in plaintext | Document risk, gitignore is sufficient for now | 5 min |
| — | S6 — Command injection | By design (trust-all-tools), document as limitation | — |


---

## Step-by-Step Execution Guide (Junior Developer)

### Prerequisites
- Read the entire document above first (including Review Findings)
- Have the project running locally (`npm start` works)
- Understand the existing code: `orchestrator.ts` (how Master is prompted), `wsServer.ts` (how messages flow)

---

### Step 1: Create `src/taskStore.ts`

**Goal:** A module that manages tasks in a JSON file.

**Start by copying this skeleton and filling in the methods:**

```ts
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
  archive(taskId: string): void;
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
  } catch { /* file doesn't exist or is corrupted — start fresh */ }

  // On startup: reset any "running" stages (crash recovery)
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
      return task;
    },

    updateStage(taskId, stageIndex, status, result, assignedTo) {
      const task = tasks.find(t => t.id === taskId);
      if (!task || !task.stages[stageIndex]) return;
      task.stages[stageIndex].status = status;
      if (result) task.stages[stageIndex].result = result.length > 300 ? result.slice(0, 300) + '...' : result;
      if (assignedTo) task.stages[stageIndex].assignedTo = assignedTo;
      task.updatedAt = now();
      scheduleSave();
    },

    setWaiting(taskId, reason, actions) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'waiting';
      task.waitingFor = reason;
      task.waitingActions = actions;
      task.updatedAt = now();
      scheduleSave();
    },

    resumeTask(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'active';
      task.waitingFor = null;
      task.waitingActions = undefined;
      task.updatedAt = now();
      scheduleSave();
    },

    complete(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'archived';
      task.updatedAt = now();
      scheduleSave();
    },

    archive(taskId) {
      const task = tasks.find(t => t.id === taskId);
      if (!task) return;
      task.status = 'archived';
      task.updatedAt = now();
      scheduleSave();
    },
  };
}
```

**How to verify:** Add this to `src/index.ts` temporarily:
```ts
const ts = createTaskStore(resolve(ORCHESTRA_DIR, 'wikis'));
const t = ts.create('Test Task', ['Step 1', 'Step 2', 'Step 3']);
console.log('Created:', t);
ts.updateStage(t.id, 0, 'done', 'Completed step 1');
console.log('After update:', ts.get(t.id));
```
Run `npm start`, check terminal output and verify `wikis/projects.json` exists with correct content. Then remove the test code.

---

### Step 2: Create `src/taskCommandParser.ts`

**Goal:** A pure function that takes Master's response string and returns structured commands.

```ts
export type TaskCommand =
  | { type: 'create'; name: string; stages: string[] }
  | { type: 'update'; taskId: string; stageIndex: number; status: string }
  | { type: 'wait'; taskId: string; reason: string; actions?: string[] }
  | { type: 'done'; taskId: string }
  | { type: 'dispatch'; workerId: string; taskId?: string; stageIndex?: number; instructions: string };

export function parseTaskCommands(response: string): TaskCommand[] {
  const commands: TaskCommand[] = [];

  // TASK_CREATE name: xxx\nSTAGE: ...\nSTAGE: ...
  const createRegex = /^TASK_CREATE\s+name:\s*(.+)\n((?:STAGE:\s*.+\n?)+)/gm;
  let m: RegExpExecArray | null;
  while ((m = createRegex.exec(response)) !== null) {
    const name = m[1].trim();
    const stages = m[2].split('\n').filter(l => l.startsWith('STAGE:')).map(l => l.replace(/^STAGE:\s*/, '').trim());
    if (name && stages.length) commands.push({ type: 'create', name, stages });
  }

  // TASK_UPDATE task-id: stage N → status
  const updateRegex = /^TASK_UPDATE\s+([\w-]+):\s*stage\s+(\d+)\s*→\s*(\w+)/gm;
  while ((m = updateRegex.exec(response)) !== null) {
    commands.push({ type: 'update', taskId: m[1], stageIndex: parseInt(m[2]) - 1, status: m[3] });
  }

  // TASK_WAIT task-id: reason [ACTION1] [ACTION2]
  const waitRegex = /^TASK_WAIT\s+([\w-]+):\s*(.+?)(?:\s*(\[.+\]))?\s*$/gm;
  while ((m = waitRegex.exec(response)) !== null) {
    const actions = m[3] ? m[3].match(/\[([^\]]+)\]/g)?.map(b => b.slice(1, -1)) : undefined;
    commands.push({ type: 'wait', taskId: m[1], reason: m[2].trim(), actions });
  }

  // TASK_DONE task-id
  const doneRegex = /^TASK_DONE\s+([\w-]+)/gm;
  while ((m = doneRegex.exec(response)) !== null) {
    commands.push({ type: 'done', taskId: m[1] });
  }

  // DISPATCH worker-id [task:xxx, stage:N]: instructions
  // Also handles plain DISPATCH worker-id: instructions (no task context)
  const parts = response.split(/^(?=DISPATCH\s)/m);
  for (const part of parts) {
    const dm = part.match(/^DISPATCH\s+([\w-]+)(?:\s*\[task:([\w-]+),\s*stage:(\d+)\])?\s*:\s*([\s\S]*)/);
    if (!dm) continue;
    const instructions = dm[4].replace(/\bDONE\s*$/, '').replace(/^TASK_/m, '').trim();
    if (!instructions) continue;
    commands.push({
      type: 'dispatch',
      workerId: dm[1],
      taskId: dm[2] || undefined,
      stageIndex: dm[3] ? parseInt(dm[3]) - 1 : undefined,
      instructions,
    });
  }

  return commands;
}
```

**How to verify:** Create a test file `test-parser.ts`:
```ts
import { parseTaskCommands } from './taskCommandParser.js';

const response = `I'll create a task for this.

TASK_CREATE name: Partner Emails
STAGE: Query OPP data
STAGE: Draft emails
STAGE: User review
STAGE: Send emails

DISPATCH worker-1 [task:task-123, stage:1]: Please query the following 5 OPPs and return their details.

TASK_UPDATE task-123: stage 1 → done

TASK_WAIT task-123: Please review the email drafts [APPROVE] [REJECT]

TASK_DONE task-123`;

console.log(JSON.stringify(parseTaskCommands(response), null, 2));
```
Run: `npx tsx test-parser.ts` — should output 5 commands with correct fields. Then delete the test file.

---

### Step 3: Modify `src/orchestrator.ts`

**Goal:** Wire taskStore + parser into the existing orchestration loop.

**What to change (3 places):**

**3a. Add imports and constructor param:**
```ts
// At top of file, add:
import { type TaskStore } from './taskStore.js';
import { parseTaskCommands } from './taskCommandParser.js';

// Change createOrchestrator signature:
export function createOrchestrator(
  sm: SessionManager,
  taskStore: TaskStore,  // ← ADD THIS
  onEvent: ...,
  onBroadcastSessions: ...,
  onBroadcastTasks: () => void,  // ← ADD THIS
): Orchestrator {
```

**3b. Add [Active Tasks] to the prompt (inside `wakeMaster`, before the `const prompt = ...` line):**
```ts
const activeTasks = taskStore.getActive();
const taskLines = activeTasks.length
  ? activeTasks.map(t => {
      const progress = t.stages.filter(s => s.status === 'done').length;
      const current = t.stages.find(s => s.status !== 'done');
      return `- ${t.id} "${t.name}" (${progress}/${t.stages.length}, ${current?.status ?? 'done'})`;
    }).join('\n')
  : '(none)';

const prompt = `[Active Tasks]\n${taskLines}\n\n[Worker Status]\n${statusLines}\n\n[New Events - ${events.length}]\n${eventLines}\n\n[Rules]\n1. Reply to user: write directly\n2. Create multi-step task: TASK_CREATE name: ...\n3. Dispatch: DISPATCH worker-id [task:id, stage:N]: instructions\n4. Stage needs user input: TASK_WAIT task-id: reason [BUTTON1] [BUTTON2]\n5. Stage done: TASK_UPDATE task-id: stage N → done\n6. All stages done: TASK_DONE task-id\n7. Simple one-shot work (no task needed): DISPATCH worker-id: instructions\n8. All done: end with DONE`;
```

**3c. After Master responds, parse and execute task commands (after the existing DISPATCH parsing, replace it):**
```ts
const cmds = parseTaskCommands(response);
for (const cmd of cmds) {
  switch (cmd.type) {
    case 'create':
      taskStore.create(cmd.name, cmd.stages);
      onBroadcastTasks();
      break;
    case 'update':
      taskStore.updateStage(cmd.taskId, cmd.stageIndex, cmd.status as any);
      onBroadcastTasks();
      break;
    case 'wait':
      taskStore.setWaiting(cmd.taskId, cmd.reason, cmd.actions);
      onBroadcastTasks();
      break;
    case 'done':
      taskStore.complete(cmd.taskId);
      onBroadcastTasks();
      break;
    case 'dispatch': {
      const worker = sm.get(cmd.workerId);
      if (worker && worker.status === 'idle') {
        if (cmd.taskId && cmd.stageIndex !== undefined) {
          taskStore.updateStage(cmd.taskId, cmd.stageIndex, 'running', undefined, cmd.workerId);
          onBroadcastTasks();
        }
        executeWorker(cmd.workerId, cmd.instructions, cmd.taskId, cmd.stageIndex);
      }
      break;
    }
  }
}
```

**3d. Update `executeWorker` signature and completion logic:**
```ts
async function executeWorker(workerId: string, task: string, taskId?: string, stageIndex?: number) {
  // ... existing code ...
  // After result is received, add:
  if (taskId && stageIndex !== undefined) {
    taskStore.updateStage(taskId, stageIndex, 'done', summarize(result));
    onBroadcastTasks();
  }
  // ... rest of existing code (push to inbox, etc.) ...
}
```

**How to verify:** Start the server, send a message like "Help me write 3 partner emails and update SFDC". Check:
1. Terminal shows no errors
2. `wikis/projects.json` gets created with a task
3. Master's response contains TASK_CREATE and DISPATCH commands

---

### Step 4: Modify `src/wsServer.ts`

**Goal:** Send task data to frontend, handle task-related user actions.

**4a. Add to `startServer` function, after creating orchestrator:**
```ts
const taskStore = createTaskStore(resolve(workspace, '..', 'wikis')); // or wherever wikis is
// Pass taskStore to orchestrator (update the createOrchestrator call)

function broadcastTasks() {
  const msg = { type: 'tasks', tasks: taskStore.getActive() };
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}
```

**4b. On new WebSocket connection, send tasks:**
```ts
wss.on('connection', (ws) => {
  clients.add(ws);
  for (const msg of history) ws.send(JSON.stringify(msg));
  broadcastSessions();
  ws.send(JSON.stringify({ type: 'tasks', tasks: taskStore.getActive() })); // ← ADD
```

**4c. Add new message handlers in the switch:**
```ts
case 'task_respond': {
  const task = taskStore.get(msg.taskId);
  if (task && task.status === 'waiting') taskStore.resumeTask(msg.taskId);
  orch.pushUserMessage(`[Task "${task?.name}"] User responded: ${msg.content}`);
  broadcastTasks();
  break;
}
case 'task_archive': {
  taskStore.archive(msg.taskId);
  broadcastTasks();
  break;
}
case 'task_create': {
  orch.pushUserMessage(`Please create a task for: ${msg.name}`);
  break;
}
```

**How to verify:** Open browser console, check that you receive a `{type: 'tasks', tasks: [...]}` message on connect.

---

### Step 5: Modify `public/index.html`

**Goal:** Add Tasks tab to sidebar, task list, stage panel.

This is the largest change. Key pieces:

**5a. Add tab buttons at top of sidebar:**
```html
<div class="sidebar-tabs">
  <button class="tab active" id="tab-chat" onclick="switchMode('chat')">Chat</button>
  <button class="tab" id="tab-tasks" onclick="switchMode('tasks')">Tasks</button>
</div>
```

**5b. Add JS state and mode switching:**
```js
let mode = 'chat'; // 'chat' or 'tasks'
let tasks = [];
let selectedTaskId = null;

function switchMode(m) {
  mode = m;
  document.getElementById('tab-chat').classList.toggle('active', m === 'chat');
  document.getElementById('tab-tasks').classList.toggle('active', m === 'tasks');
  if (m === 'chat') { renderChannels(); renderMessages(); renderActivity(); }
  else { renderTaskList(); renderTaskDetail(); renderTaskStages(); }
}
```

**5c. Handle `tasks` message from server:**
```js
// In ws.onmessage:
else if (msg.type === 'tasks') { tasks = msg.tasks; if (mode === 'tasks') renderTaskList(); }
```

**5d. Render task list in sidebar (when Tasks mode):**
```js
function renderTaskList() {
  const active = tasks.filter(t => t.status !== 'archived');
  const archived = tasks.filter(t => t.status === 'archived');
  let html = active.map(t => `<div class="task-item ${t.id === selectedTaskId ? 'active' : ''}" onclick="selectTask('${t.id}')">
    <div class="task-name">${esc(t.name)}</div>
    <div class="task-status">${t.status === 'waiting' ? '⏸ ' + esc(t.waitingFor||'') : '⏳'}</div>
  </div>`).join('');
  if (archived.length) html += `<div class="task-section">✅ Done (${archived.length})</div>`;
  html += `<div class="task-item new" onclick="newTask()">+ New Task</div>`;
  channelsEl.innerHTML = html;
}
```

**5e. Render stages in right panel (when task selected):**
```js
function renderTaskStages() {
  const task = tasks.find(t => t.id === selectedTaskId);
  if (!task) { activityContent.innerHTML = ''; return; }
  activityContent.innerHTML = task.stages.map((s, i) => {
    const icon = s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : s.status === 'waiting_user' ? '⏸' : '○';
    return `<div class="stage ${s.status}">${icon} ${i+1}. ${esc(s.name)}</div>`;
  }).join('');
}
```

**How to verify:** Switch to Tasks tab, create a task via chat ("help me do X in 3 steps"), verify it appears in the task list with stages on the right.

---

### Step 6: Update Master persona in `src/index.ts`

**Goal:** Tell Master about the task command protocol.

Add this block to `masterPersona`:
```
Task Management:
- For multi-step requests, create a task: TASK_CREATE name: <name>\nSTAGE: <step1>\nSTAGE: <step2>\n...
- Dispatch work for a task stage: DISPATCH worker-id [task:<task-id>, stage:<N>]: instructions
- When a stage needs user input: TASK_WAIT <task-id>: reason [BUTTON1] [BUTTON2]
- When a stage completes: TASK_UPDATE <task-id>: stage <N> → done
- When all stages are done: TASK_DONE <task-id>
- For simple one-shot requests, don't create a task — just DISPATCH directly.
- Stage numbers are 1-based (first stage = 1).
- Command keywords must always be in English. Content can be any language.
```

**How to verify:** Start Master, ask "help me write 5 emails to partners". Master should respond with TASK_CREATE + DISPATCH commands.

---

### Common Mistakes to Avoid

1. **Don't let Master write JSON** — it will get the format wrong. Only Server writes projects.json.
2. **Don't forget 1-based → 0-based conversion** — Master says "stage 1", array index is 0.
3. **Don't send archived tasks in broadcastTasks** — only active/waiting. Load archived on demand.
4. **Don't block on scheduleSave** — it's async (setTimeout), mutations are in-memory first.
5. **Don't forget to call `onBroadcastTasks()`** after every taskStore mutation in orchestrator.
6. **Test with simple tasks first** — "count to 10" before trying complex multi-stage work.
