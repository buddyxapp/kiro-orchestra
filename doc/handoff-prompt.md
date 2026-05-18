# Handoff Prompt — Task View Implementation

You are implementing the "Task View" feature for kiro-orchestra. 

## Your instructions

1. Read `KIRO.md` in the project root. Follow those principles strictly.
2. Read `doc/task-view-plan.md` completely before writing any code.
3. Execute the implementation in the exact order specified in the "Step-by-Step Execution Guide" section.
4. After completing each step, run the "How to verify" test described in that step. Do NOT proceed to the next step until verification passes.
5. If a step is unclear or conflicts with existing code, stop and ask — do not guess.

## Execution checklist

- [ ] Step 1: Create `src/taskStore.ts` → verify by creating a test task and checking `wikis/projects.json`
- [ ] Step 2: Create `src/taskCommandParser.ts` → verify by running the test parser with sample input
- [ ] Step 3: Modify `src/orchestrator.ts` → verify by sending a multi-step request and checking projects.json gets populated
- [ ] Step 4: Modify `src/wsServer.ts` → verify by checking browser console receives `{type: 'tasks'}` message
- [ ] Step 5: Modify `public/index.html` → verify by switching to Tasks tab and seeing task list + stages
- [ ] Step 6: Update Master persona in `src/index.ts` → verify by asking Master to do a multi-step task and confirming it uses TASK_CREATE

## Rules

- Do NOT skip the "Code Review Findings" section — it contains critical fixes (regex compatibility, ID lifecycle, stage index convention) that must be incorporated.
- Do NOT let AI write to `projects.json` directly. Only `taskStore.ts` writes that file.
- Do NOT break existing Chat mode functionality. Task mode is additive.
- Stage numbers in Master commands are 1-based. Convert to 0-based in parser.
- Command keywords (`TASK_CREATE`, `DISPATCH`, etc.) are always English. Content can be any language.
- Run `npx tsc --noEmit` after every file change. Fix type errors before moving on.
- Keep changes minimal and surgical per KIRO.md principles.

## Context

- Project: https://github.com/buddyxapp/kiro-orchestra
- Working directory: the kiro-orchestra project root
- Existing code to understand first: `src/orchestrator.ts`, `src/wsServer.ts`, `src/sessionManager.ts`
- The plan document has all the code you need — follow it, don't reinvent.
