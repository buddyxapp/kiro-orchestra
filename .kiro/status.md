# Kiro Orchestra — Current Status (2026-05-22)

## Repo
- GitHub: https://github.com/buddyxapp/kiro-orchestra (public, MIT)
- Local: D:\Users\yianhan\OneDrive - amazon.com\Documents\Kiro\OpenABWindows\kiro-orchestra
- Latest commit: after heartbeat cooldown fix + dispatch ACK + /api/execute taskId parsing

## What It Is
Local multi-agent orchestration UI for kiro-cli. Slack-like interface with Master (commander) + 4 Workers running in parallel. Each agent is a kiro-cli ACP process.

## Architecture
- Server: Node.js + TypeScript + ws (WebSocket)
- Frontend: Single HTML file, vanilla JS, no build step
- AI: kiro-cli via ACP protocol (JSON-RPC over stdin/stdout)
- Memory: Per-agent wiki dirs + projects.json for task state

## Key Files
- src/index.ts — entry point, agent configs, Master persona
- src/orchestrator.ts — event-driven inbox, task commands, heartbeat, dispatch ACK
- src/wsServer.ts — HTTP + WebSocket server, /api/execute endpoint
- src/sessionManager.ts — manages kiro-cli processes
- src/taskStore.ts — task CRUD + persistence (wikis/projects.json)
- src/taskCommandParser.ts — parses TASK_CREATE/UPDATE/WAIT/DONE/DISPATCH from Master response
- src/acpBackend.ts — spawns kiro-cli, ACP protocol
- public/index.html — UI (Chat + Tasks tabs, Activity panel, markdown rendering)
- public/orchestra.js — helper for HTML reports (execute buttons)
- public/report-template.html — template for actionable HTML reports
- skills/pptx-generation.md — PPTX skill (pptxgenjs + Gemini)
- skills/office-modify.md — Office read/modify skill (python-pptx, openpyxl, LibreOffice)
- doc/task-view-plan.md — full implementation plan + review findings
- doc/reliability-plan.md — dispatch ACK + heartbeat design
- doc/handoff-prompt.md — handoff prompt for new developers
- demo/ — 5 fake emails for testing without MCP
- KIRO.md — shared behavior rules for all agents

## Recent Features Implemented
1. Task View — create/stages/scope guard/reopen/delete/TASK_WAIT requires user confirm
2. Heartbeat — every 5 min checks for stuck/missed dispatches (Method C + cooldown after error)
3. Dispatch ACK — immediate notification when worker unavailable
4. Task conversation isolation — taskId tagging, separate taskLogs in frontend
5. HTML Report Execute — orchestra.js + /api/execute + meta tags (report name, task ID, after-done)
6. Markdown rendering in chat (tables, code blocks, headings, bold, links)
7. Command badges (DISPATCH/TASK_* shown as colored badges, not raw text)
8. Image paste (saved to file, agent reads via read tool)
9. Model selection per agent (--model flag, restart on change)
10. Stop button (cancel without killing agent)
11. Workspace Root setting (all agents share, restart on change)
12. Parallel dispatch rule (2+ items + 2+ idle workers = always split)

## Known Issues / Pending
- Master sometimes doesn't use TASK_CREATE format (format compliance ~95%)
- Task view streaming: in Tasks mode, messages appear after turn_end (not real-time)
- Heartbeat cooldown: 15 min after Master error
- session/load doesn't work across restarts (kiro-cli limitation)
- Old token in git history (revoked, harmless)

## User's Workspace
- Project: D:\Users\yianhan\OneDrive - amazon.com\Documents\Kiro\AP26 AWS Sales Planning
- Orchestra: D:\Users\yianhan\OneDrive - amazon.com\Documents\Kiro\OpenABWindows\kiro-orchestra
- Git: D:\Users\yianhan\AppData\Local\MinGit\cmd\git.exe
- GitHub token in .git/config remote URL (not in tracked files)

## Unpushed Changes
- Heartbeat cooldown fix (heartbeatCooldownUntil)
- /api/execute taskId parsing
- Orchestra directory path in init prompt
- Report template URL → file path reference
- Parallel dispatch rule improvement
- Command badges in linkify
- Various UI fixes

## To Resume
1. Push unpushed changes: `git add -A && git commit -m "..." && git push`
2. Restart server: `npx tsx src/index.ts`
3. Check doc/task-view-plan.md and doc/reliability-plan.md for pending design decisions
