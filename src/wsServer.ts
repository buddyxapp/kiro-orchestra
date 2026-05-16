/**
 * WebSocket + HTTP server — serves UI, routes messages via orchestrator.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { type AcpEvent } from './acpProtocol.js';
import { type SessionManager, type AgentConfig } from './sessionManager.js';
import { createOrchestrator } from './orchestrator.js';
import { logger } from './logger.js';

export type ClientMsg =
  | { type: 'user_message'; content: string }
  | { type: 'add_agent'; config: AgentConfig }
  | { type: 'update_agent'; id: string; name: string; persona: string }
  | { type: 'remove_agent'; id: string }
  | { type: 'start_agent'; id: string }
  | { type: 'stop_agent'; id: string }
  | { type: 'cancel_agent'; id: string }
  | { type: 'start_all' };

export type ServerMsg =
  | { type: 'agent_event'; agentId: string; event: AcpEvent }
  | { type: 'sessions'; sessions: Array<{ id: string; name: string; role: string; status: string; persona: string }> }
  | { type: 'error'; message: string };

export function startServer(port: number, sm: SessionManager, workspace: string) {
  const publicDir = resolve(import.meta.dirname, '..', 'public');
  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(resolve(publicDir, 'index.html')));
    } else { res.writeHead(404); res.end('Not found'); }
  });

  const wss = new WebSocketServer({ server });
  const clients = new Set<WebSocket>();
  const MAX_HISTORY = 100;
  const history: ServerMsg[] = [];

  function broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
    if (msg.type === 'agent_event') { history.push(msg); if (history.length > MAX_HISTORY) history.shift(); }
  }

  function broadcastSessions() {
    broadcast({ type: 'sessions', sessions: sm.getAll().map(s => ({
      id: s.config.id, name: s.config.name, role: s.config.role, status: s.status, persona: s.config.persona,
    }))});
  }

  function onEvent(agentId: string, event: AcpEvent) {
    broadcast({ type: 'agent_event', agentId, event });
    if (event.type === 'turn_end') broadcastSessions();
  }

  const orch = createOrchestrator(sm, onEvent, broadcastSessions);

  wss.on('connection', (ws) => {
    clients.add(ws);
    for (const msg of history) ws.send(JSON.stringify(msg));
    broadcastSessions();

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientMsg;
        switch (msg.type) {
          case 'add_agent': sm.addAgent(msg.config); broadcastSessions(); break;
          case 'update_agent': { const a = sm.get(msg.id); if (a) { a.config.name = msg.name; a.config.persona = msg.persona; } broadcastSessions(); break; }
          case 'remove_agent': sm.removeAgent(msg.id); broadcastSessions(); break;
          case 'start_agent': try { await sm.startAgent(msg.id); } catch (e) { broadcast({ type: 'error', message: (e as Error).message }); } broadcastSessions(); break;
          case 'stop_agent': sm.stopAgent(msg.id); broadcastSessions(); break;
          case 'cancel_agent': sm.cancelAgent(msg.id); broadcast({ type: 'agent_event', agentId: 'system', event: { type: 'text', content: `⏸️ ${sm.get(msg.id)?.config.name ?? msg.id} 取消任務` } }); broadcastSessions(); break;
          case 'start_all': for (const s of sm.getAll()) { if (s.status === 'stopped') try { await sm.startAgent(s.config.id); } catch {} } broadcastSessions(); break;

          case 'user_message': {
            if (!msg.content) break;
            const text = msg.content.trim();

            // Interrupt
            if (text === 'stop' || text === '中斷') {
              orch.abort();
              for (const s of sm.getAll()) if (s.status === 'working') sm.cancelAgent(s.config.id);
              broadcast({ type: 'agent_event', agentId: 'system', event: { type: 'text', content: '⛔ 已中斷所有任務' } });
              broadcastSessions(); break;
            }

            broadcast({ type: 'agent_event', agentId: 'user', event: { type: 'text', content: msg.content } });

            // @mention direct to worker (bypass orchestrator)
            if (text.startsWith('@')) {
              const after = text.slice(1);
              if (after.startsWith('all ') || after === 'all') {
                const p = after.slice(3).trim() || 'hi';
                for (const s of sm.getAll()) if (s.status === 'idle' && s.config.role === 'worker') sm.sendPrompt(s.config.id, p, onEvent).catch(() => {});
                broadcastSessions(); break;
              }
              const sorted = sm.getAll().sort((a, b) => b.config.name.length - a.config.name.length);
              for (const a of sorted) {
                if (after.startsWith(a.config.name + ' ') || after === a.config.name) {
                  const p = after.slice(a.config.name.length).trim() || 'hi';
                  if (a.config.role === 'worker') {
                    if (a.status === 'idle') sm.sendPrompt(a.config.id, p, onEvent).catch(() => {});
                    else broadcast({ type: 'error', message: `${a.config.name} is ${a.status}` });
                  } else {
                    orch.pushUserMessage(p);
                  }
                  broadcastSessions(); break;
                }
              }
              // If no match, fall through to orchestrator
            }

            // Default: orchestrator (master)
            orch.pushUserMessage(msg.content);
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
