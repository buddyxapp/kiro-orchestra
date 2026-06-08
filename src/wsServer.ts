/**
 * WebSocket + HTTP server — serves UI, routes messages via orchestrator.
 */
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { type AcpEvent } from './acpProtocol.js';
import { type SessionManager, type AgentConfig } from './sessionManager.js';
import { createOrchestrator } from './orchestrator.js';
import { createTaskStore, type TaskStore } from './taskStore.js';
import { logger } from './logger.js';

export type ClientMsg =
  | { type: 'user_message'; content: string; image?: { media_type: string; data: string } }
  | { type: 'add_agent'; config: AgentConfig }
  | { type: 'update_agent'; id: string; name: string; persona: string; cwd?: string }
  | { type: 'remove_agent'; id: string }
  | { type: 'start_agent'; id: string }
  | { type: 'stop_agent'; id: string }
  | { type: 'cancel_agent'; id: string }
  | { type: 'set_config'; id: string; configId: string; value: string }
  | { type: 'start_all' }
  | { type: 'task_respond'; taskId: string; content: string; image?: { media_type: string; data: string } }
  | { type: 'task_archive'; taskId: string }
  | { type: 'task_delete'; taskId: string }
  | { type: 'task_reopen'; taskId: string }
  | { type: 'task_create'; name: string }
  | { type: 'set_workspace'; cwd: string };

export type ServerMsg =
  | { type: 'agent_event'; agentId: string; event: AcpEvent; taskId?: string }
  | { type: 'sessions'; sessions: Array<{ id: string; name: string; role: string; status: string; persona: string; cwd: string }> }
  | { type: 'tasks'; tasks: unknown[] }
  | { type: 'error'; message: string };

export function startServer(port: number, sm: SessionManager, workspace: string) {
  const publicDir = resolve(import.meta.dirname, '..', 'public');
  const wikisDir = resolve(import.meta.dirname, '..', 'wikis');
  const taskStore = createTaskStore(wikisDir);
  const server = createServer((req, res) => {
    // API: execute action from external HTML reports
    if (req.url === '/api/execute' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        try {
          const { content } = JSON.parse(body);
          if (content) {
            // Parse task ID from [REPORT_EXEC] header if present
            const taskMatch = content.match(/\[task:([\w-]+)\]/);
            const taskId = taskMatch ? taskMatch[1] : undefined;
            broadcast({ type: 'agent_event', agentId: 'user', event: { type: 'text', content }, taskId });
            orch.pushUserMessage(content, undefined, taskId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end('{"ok":true}');
        } catch { res.writeHead(400); res.end('{"error":"invalid json"}'); }
      });
      return;
    }
    // CORS preflight for /api/execute
    if (req.url === '/api/execute' && req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end(); return;
    }

    const url = req.url === '/' ? '/index.html' : req.url!;
    const filePath = resolve(publicDir, '.' + decodeURIComponent(url.split('?')[0]));
    if (!filePath.startsWith(publicDir + (process.platform === 'win32' ? '\\' : '/'))) { res.writeHead(403); res.end(); return; }
    try {
      const content = readFileSync(filePath);
      const ext = url.split('.').pop();
      const types: Record<string, string> = { html: 'text/html', js: 'application/javascript', css: 'text/css', json: 'application/json' };
      res.writeHead(200, { 'Content-Type': (types[ext!] || 'text/plain') + '; charset=utf-8' });
      res.end(content);
    } catch { res.writeHead(404); res.end('Not found'); }
  });

  const wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 }); // 10MB limit
  const clients = new Set<WebSocket>();
  const MAX_HISTORY = 500;
  const history: ServerMsg[] = [];
  const transcriptDir = resolve(publicDir, '..', 'wikis', 'transcripts');
  mkdirSync(transcriptDir, { recursive: true });

  function evictToTranscript(msg: ServerMsg) {
    const file = resolve(transcriptDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    try { appendFileSync(file, JSON.stringify(msg) + '\n'); } catch { /* best effort */ }
  }

  function broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
    if (msg.type === 'agent_event') {
      // Strip image data from history to prevent memory bloat
      const stored = ('image' in msg.event && msg.event.image) ? { ...msg, event: { ...msg.event, image: undefined } } as ServerMsg : msg;
      history.push(stored);
      if (history.length > MAX_HISTORY) evictToTranscript(history.shift()!);
    }
  }

  function broadcastSessions() {
    broadcast({ type: 'sessions', sessions: sm.getAll().map(s => ({
      id: s.config.id, name: s.config.name, role: s.config.role, status: s.status, persona: s.config.persona, cwd: s.config.cwd, model: s.config.model, configOptions: s.configOptions,
    }))});
  }

  function onEvent(agentId: string, event: AcpEvent) {
    broadcast({ type: 'agent_event', agentId, event });
    if (event.type === 'turn_end') broadcastSessions();
  }

  function onTaskEvent(taskId: string, agentId: string, content: string) {
    // Send as task-tagged event (not duplicated in #all chat — streaming already showed it)
    const msg: ServerMsg = { type: 'agent_event', agentId, event: { type: 'text', content }, taskId };
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
    // Store in history for replay on refresh
    history.push(msg);
    if (history.length > MAX_HISTORY) evictToTranscript(history.shift()!);
  }

  const orch = createOrchestrator(sm, taskStore, onEvent, onTaskEvent, broadcastSessions, broadcastTasks);

  function broadcastTasks() {
    const msg: ServerMsg = { type: 'tasks', tasks: taskStore.getAll() };
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  wss.on('connection', (ws) => {
    clients.add(ws);
    for (const msg of history) ws.send(JSON.stringify(msg));
    broadcastSessions();
    ws.send(JSON.stringify({ type: 'tasks', tasks: taskStore.getAll() }));

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMsg;
        switch (msg.type) {
          case 'add_agent': sm.addAgent(msg.config); broadcastSessions(); break;
          case 'update_agent': { const a = sm.get(msg.id); if (a) { a.config.name = msg.name; a.config.persona = msg.persona; if (msg.cwd) a.config.cwd = msg.cwd; } broadcastSessions(); break; }
          case 'remove_agent': sm.removeAgent(msg.id); broadcastSessions(); break;
          case 'start_agent': try { await sm.startAgent(msg.id); } catch (e) { broadcast({ type: 'error', message: (e as Error).message }); } broadcastSessions(); break;
          case 'stop_agent': sm.stopAgent(msg.id); broadcastSessions(); break;
          case 'cancel_agent': sm.cancelAgent(msg.id); broadcast({ type: 'agent_event', agentId: 'system', event: { type: 'text', content: `⏸️ ${sm.get(msg.id)?.config.name ?? msg.id} cancelled` } }); broadcastSessions(); break;
          case 'set_config': {
            // Model change requires restart
            const agent = sm.get(msg.id);
            if (agent && msg.configId === 'model') {
              agent.config.model = msg.value;
              if (agent.status !== 'stopped') {
                sm.stopAgent(msg.id);
                try { await sm.startAgent(msg.id); } catch (e) { broadcast({ type: 'error', message: (e as Error).message }); }
              }
            }
            broadcastSessions(); break;
          }
          case 'start_all': for (const s of sm.getAll()) { if (s.status === 'stopped') try { await sm.startAgent(s.config.id); } catch {} } broadcastSessions(); break;

          case 'task_respond': {
            const task = taskStore.get(msg.taskId);
            if (!task) break;
            // Handle action button responses
            if (msg.content === 'COMPLETE') { taskStore.complete(msg.taskId); broadcastTasks(); break; }
            if (msg.content === 'CONTINUE') { taskStore.resumeTask(msg.taskId); broadcastTasks(); break; }
            // Normal response
            if (task.status === 'waiting') taskStore.resumeTask(msg.taskId);
            broadcast({ type: 'agent_event', agentId: 'user', event: { type: 'text', content: `[Task "${task.name}"] ${msg.content}` }, taskId: msg.taskId });
            orch.pushUserMessage(`[Task "${task.name}"] User responded: ${msg.content}`, msg.image, msg.taskId);
            broadcastTasks(); break;
          }
          case 'task_archive': taskStore.complete(msg.taskId); broadcastTasks(); break;
          case 'task_delete': taskStore.delete(msg.taskId); broadcastTasks(); break;
          case 'task_reopen': taskStore.reopen(msg.taskId); broadcastTasks(); break;
          case 'task_create': {
            // Create task immediately with no stages — user will discuss with Master inside
            taskStore.create(msg.name, []);
            broadcastTasks();
            break;
          }
          case 'set_workspace': {
            for (const s of sm.getAll()) {
              s.config.cwd = msg.cwd;
              if (s.status !== 'stopped') sm.stopAgent(s.config.id);
            }
            broadcastSessions();
            break;
          }

          case 'user_message': {
            if (!msg.content && !msg.image) break;
            const text = (msg.content || '').trim();

            // Interrupt
            if (text === 'stop' || text === '中斷') {
              orch.abort();
              for (const s of sm.getAll()) if (s.status === 'working') sm.cancelAgent(s.config.id);
              broadcast({ type: 'agent_event', agentId: 'system', event: { type: 'text', content: '⛔ All tasks interrupted' } });
              broadcastSessions(); break;
            }

            // Broadcast user message (include image data for display)
            const userEvent: AcpEvent = msg.image
              ? { type: 'text', content: text || '📎 (image)', image: msg.image }
              : { type: 'text', content: text };
            broadcast({ type: 'agent_event', agentId: 'user', event: userEvent });
            const imgArr = msg.image ? [msg.image] : undefined;

            // @mention direct to worker (bypass orchestrator)
            let handled = false;
            if (text.startsWith('@')) {
              const after = text.slice(1);
              if (after.startsWith('all ') || after === 'all') {
                const p = after.slice(3).trim() || 'hi';
                for (const s of sm.getAll()) if (s.status === 'idle' && s.config.role === 'worker') sm.sendPrompt(s.config.id, p, onEvent, imgArr).catch(() => {});
                handled = true;
              } else {
                const sorted = sm.getAll().sort((a, b) => b.config.name.length - a.config.name.length);
                for (const a of sorted) {
                  if (after.startsWith(a.config.name + ' ') || after === a.config.name) {
                    const p = after.slice(a.config.name.length).trim() || 'hi';
                    if (a.config.role === 'worker') {
                      if (a.status === 'idle') sm.sendPrompt(a.config.id, p, onEvent, imgArr).catch(() => {});
                      else broadcast({ type: 'error', message: `${a.config.name} is ${a.status}` });
                    } else {
                      orch.pushUserMessage(p, msg.image);
                    }
                    handled = true; break;
                  }
                }
              }
            }

            // Default: orchestrator (master)
            if (!handled) orch.pushUserMessage(text || '(see attached image)', msg.image);
            broadcastSessions(); break;
          }
        }
      } catch (err) { logger.error('WS error', { error: (err as Error).message }); }
    });
    ws.on('close', () => clients.delete(ws));
  });

  server.listen(port, () => logger.info(`🚀 Kiro Orchestra running at http://localhost:${port}`));
  return { server, wss };
}
