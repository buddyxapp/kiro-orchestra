/**
 * Session Manager — lazy-start agents with separate cwd and wiki dir.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAcpBackend, type AcpBackend } from './acpBackend.js';
import { type AcpEvent, type ContentBlock } from './acpProtocol.js';
import { logger } from './logger.js';

export interface AgentConfig {
  id: string;
  name: string;
  persona: string;
  role: 'master' | 'worker';
  cwd: string;
  model: string;  // 'auto' or specific model id
}

export interface AgentSession {
  config: AgentConfig;
  backend: AcpBackend | null;
  status: 'stopped' | 'starting' | 'idle' | 'working';
  wikiDir: string;
  configOptions: Array<{ id: string; name: string; currentValue: string; options: Array<{ value: string; name: string }> }>;
}

export interface SessionManager {
  getAll(): AgentSession[];
  get(id: string): AgentSession | undefined;
  addAgent(config: AgentConfig): void;
  removeAgent(id: string): void;
  startAgent(id: string): Promise<void>;
  stopAgent(id: string): void;
  cancelAgent(id: string): void;
  setConfigOption(id: string, configId: string, value: string): Promise<void>;
  sendPrompt(id: string, text: string, onEvent: (agentId: string, event: AcpEvent) => void, images?: Array<{ media_type: string; data: string }>): Promise<string>;
  getIdleWorker(): AgentSession | undefined;
  stopAll(): void;
}

export function createSessionManager(command: string, args: string[], orchestraDir: string): SessionManager {
  const sessions = new Map<string, AgentSession>();
  const wikisRoot = resolve(orchestraDir, 'wikis');

  return {
    getAll: () => [...sessions.values()],
    get: (id) => sessions.get(id),

    addAgent(config: AgentConfig) {
      const wikiDir = resolve(wikisRoot, config.id);
      mkdirSync(wikiDir, { recursive: true });
      sessions.set(config.id, { config, backend: null, status: 'stopped', wikiDir, configOptions: [] });
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
      const agentArgs = s.config.model && s.config.model !== 'auto'
        ? [...args, '--model', s.config.model]
        : args;
      const backend = createAcpBackend(command, agentArgs, s.config.cwd);
      await backend.start();
      await backend.sessionNew(s.config.cwd);

      s.backend = backend;
      s.configOptions = backend.getConfigOptions();
      logger.info('configOptions received', { options: JSON.stringify(s.configOptions) });

      // Detect unexpected process exit
      backend.onClose((code) => {
        if (s.backend === backend) {
          logger.warn(`Agent "${s.config.name}" (${id}) exited unexpectedly`, { code });
          s.backend = null;
          s.status = 'stopped';
        }
      });

      // Send persona + KIRO.md guidelines
      if (s.config.persona) {
        let kiroMd = '';
        try { kiroMd = readFileSync(resolve(wikisRoot, '..', 'KIRO.md'), 'utf-8'); } catch { /* optional */ }
        const initPrompt = `${s.config.persona}\n\n---\n\n${kiroMd ? `## Shared Guidelines (KIRO.md)\n\n${kiroMd}\n\n---\n\n` : ''}Your wiki directory: ${s.wikiDir}\nWorking directory: ${s.config.cwd}\n\nConfirm your role in one sentence.`;
        await backend.sendPrompt([{ type: 'text', text: initPrompt }], () => {});
      }

      s.status = 'idle';
      logger.info(`Agent started: ${s.config.name} (${id}) cwd=${s.config.cwd}`);
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
      logger.info(`Cancelled: ${s.config.name} (${id})`);
      // Force kill if still working after 5s
      const backend = s.backend;
      setTimeout(() => {
        if (s.backend === backend && s.status === 'working') {
          logger.warn(`Force-killing unresponsive agent: ${s.config.name} (${id})`);
          s.backend?.stop();
          s.backend = null;
          s.status = 'stopped';
        }
      }, 5000);
    },

    async setConfigOption(id: string, configId: string, value: string) {
      const s = sessions.get(id);
      if (!s?.backend) throw new Error(`Agent ${id} not running`);
      await s.backend.setConfigOption(configId, value);
      s.configOptions = s.backend.getConfigOptions();
    },

    async sendPrompt(id: string, text: string, onEvent, images?: Array<{ media_type: string; data: string }>) {
      const s = sessions.get(id);
      if (!s?.backend) throw new Error(`Agent ${id} not running`);
      s.status = 'working';
      const content: ContentBlock[] = [];
      if (images && images.length) {
        // Save image to file — kiro-cli ACP crashes with inline image blocks
        const imagesDir = resolve(wikisRoot, 'images');
        mkdirSync(imagesDir, { recursive: true });
        const paths: string[] = [];
        for (const img of images) {
          const ext = img.media_type.includes('png') ? 'png' : 'jpg';
          const filepath = resolve(imagesDir, `img-${Date.now()}.${ext}`);
          writeFileSync(filepath, Buffer.from(img.data, 'base64'));
          paths.push(filepath);
        }
        content.push({ type: 'text', text: `${text}\n\n[User attached ${paths.length} image(s). Saved to:\n${paths.join('\n')}\nUse the read tool in Image mode to view them.]` });
      } else {
        content.push({ type: 'text', text });
      }
      try {
        const result = await s.backend.sendPrompt(content, (ev) => onEvent(id, ev));
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
