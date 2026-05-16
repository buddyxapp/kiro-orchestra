/**
 * Session Manager — lazy-start agents with wiki dirs and per-agent cancel.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAcpBackend, type AcpBackend } from './acpBackend.js';
import { type AcpEvent, type ContentBlock } from './acpProtocol.js';
import { logger } from './logger.js';

export interface AgentConfig {
  id: string;
  name: string;
  persona: string;
  role: 'master' | 'worker';
}

export interface AgentSession {
  config: AgentConfig;
  backend: AcpBackend | null;
  status: 'stopped' | 'starting' | 'idle' | 'working';
  wikiDir: string;
}

export interface SessionManager {
  getAll(): AgentSession[];
  get(id: string): AgentSession | undefined;
  addAgent(config: AgentConfig): void;
  removeAgent(id: string): void;
  startAgent(id: string): Promise<void>;
  stopAgent(id: string): void;
  cancelAgent(id: string): void;
  sendPrompt(id: string, text: string, onEvent: (agentId: string, event: AcpEvent) => void): Promise<string>;
  getIdleWorker(): AgentSession | undefined;
  stopAll(): void;
}

export function createSessionManager(command: string, args: string[], workspace: string): SessionManager {
  const sessions = new Map<string, AgentSession>();
  const wikisRoot = resolve(workspace, 'wikis');

  return {
    getAll: () => [...sessions.values()],
    get: (id) => sessions.get(id),

    addAgent(config: AgentConfig) {
      const wikiDir = resolve(wikisRoot, config.id);
      mkdirSync(wikiDir, { recursive: true });
      sessions.set(config.id, { config, backend: null, status: 'stopped', wikiDir });
    },

    removeAgent(id: string) {
      const s = sessions.get(id);
      if (s?.backend) s.backend.stop();
      sessions.delete(id);
    },

    async startAgent(id: string) {
      const s = sessions.get(id);
      if (!s) throw new Error(`Agent ${id} not found`);
      if (s.backend?.isAlive()) return;

      s.status = 'starting';
      const backend = createAcpBackend(command, args, s.wikiDir);
      await backend.start();
      await backend.sessionNew(s.wikiDir);
      s.backend = backend;

      // Send persona + wiki instructions
      if (s.config.persona) {
        await backend.sendPrompt(
          [{ type: 'text', text: `你的名字是「${s.config.name}」。${s.config.persona}\n\n你的 wiki 目錄在當前工作目錄。請簡短確認你理解角色（一句話）。` }],
          () => {},
        );
      }

      s.status = 'idle';
      logger.info(`Agent started: ${s.config.name} (${id})`);
    },

    stopAgent(id: string) {
      const s = sessions.get(id);
      if (!s) return;
      s.backend?.stop();
      s.backend = null;
      s.status = 'stopped';
    },

    cancelAgent(id: string) {
      const s = sessions.get(id);
      if (!s || !s.backend) return;
      s.backend.cancel();
      // Status will return to idle after the cancelled prompt rejects
      logger.info(`Cancelled: ${s.config.name} (${id})`);
    },

    async sendPrompt(id: string, text: string, onEvent) {
      const s = sessions.get(id);
      if (!s?.backend) throw new Error(`Agent ${id} not running`);
      s.status = 'working';
      try {
        const result = await s.backend.sendPrompt([{ type: 'text', text }], (ev) => onEvent(id, ev));
        return result;
      } finally {
        if (s.backend?.isAlive()) s.status = 'idle';
      }
    },

    getIdleWorker() {
      for (const s of sessions.values()) {
        if (s.config.role === 'worker' && s.status === 'idle') return s;
      }
      return undefined;
    },

    stopAll() {
      for (const s of sessions.values()) { s.backend?.stop(); s.backend = null; s.status = 'stopped'; }
    },
  };
}
