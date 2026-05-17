/**
 * ACP Backend — spawns and controls a kiro-cli acp process.
 * Adapted from OpenABWindows for kiro-orchestra.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import { type JsonRpcMessage, type AcpEvent, type ContentBlock, type ConfigOption, classifyNotification, buildPermissionResponse, makeRequest, makeResponse, parseConfigOptions } from './acpProtocol.js';

export interface AcpBackend {
  start(): Promise<void>;
  stop(): void;
  isAlive(): boolean;
  getSessionId(): string | null;
  getConfigOptions(): Array<{ id: string; name: string; currentValue: string; options: Array<{ value: string; name: string }> }>;
  sessionNew(cwd: string): Promise<string>;
  sessionLoad(sid: string, cwd: string): Promise<string>;
  setConfigOption(configId: string, value: string): Promise<void>;
  sendPrompt(content: ContentBlock[], onEvent: (event: AcpEvent) => void): Promise<string>;
  cancel(): void;
  onClose(cb: (code: number | null) => void): void;
}

export function createAcpBackend(command: string, args: string[], workingDir?: string, extraEnv?: Record<string, string>): AcpBackend {
  let proc: ChildProcess | null = null;
  let nextId = 1;
  let sessionId: string | null = null;
  let configOptions: ConfigOption[] = [];
  let closeCallback: ((code: number | null) => void) | null = null;
  const pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (e: Error) => void }>();
  let promptSubscriber: ((msg: JsonRpcMessage) => void) | null = null;
  let rl: ReturnType<typeof createInterface> | null = null;

  function writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!proc?.stdin?.writable) return reject(new Error('stdin not writable'));
      proc.stdin.write(line + '\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  async function sendRequest(method: string, params?: unknown, timeoutMs = 30000): Promise<JsonRpcMessage> {
    const id = nextId++;
    const line = makeRequest(id, method, params);
    logger.debug('acp_send', { method, id });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      writeLine(line).catch((err) => { clearTimeout(timer); pending.delete(id); reject(err); });
    });
  }

  function handleMessage(msg: JsonRpcMessage): void {
    if (msg.method === 'session/request_permission' && msg.id != null) {
      const outcome = buildPermissionResponse(msg.params);
      writeLine(makeResponse(msg.id, outcome)).catch(() => {});
      return;
    }
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (promptSubscriber) promptSubscriber(msg);
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg);
        return;
      }
    }
    if (promptSubscriber) promptSubscriber(msg);
  }

  return {
    async start() {
      if (proc) return;
      sessionId = null; pending.clear(); promptSubscriber = null;
      const env = { ...process.env, ...extraEnv };
      proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: workingDir, env });
      rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => { const t = line.trim(); if (!t) return; try { handleMessage(JSON.parse(t)); } catch { /* non-JSON */ } });
      proc.stderr?.on('data', (d: Buffer) => logger.debug('acp_stderr', { line: d.toString().trim() }));
      proc.on('error', (err) => { for (const [, p] of pending) p.reject(err); pending.clear(); proc = null; });
      proc.on('close', (code) => { logger.warn('ACP process exited', { code }); for (const [, p] of pending) p.reject(new Error(`exited: ${code}`)); pending.clear(); proc = null; sessionId = null; if (closeCallback) closeCallback(code); });
      await sendRequest('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'kiro-orchestra', version: '0.1.0' } }, 120000);
      logger.info('ACP initialized');
    },
    stop() {
      if (!proc) return;
      promptSubscriber = null; sessionId = null;
      for (const [, p] of pending) p.reject(new Error('stopped')); pending.clear();
      try {
        if (proc.pid) {
          if (process.platform === 'win32') execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: 'ignore' });
          else process.kill(-proc.pid, 'SIGTERM');
        }
      } catch { try { proc?.kill(); } catch { /* */ } }
      proc = null;
    },
    isAlive: () => proc != null && !proc.killed,
    getSessionId: () => sessionId,
    getConfigOptions: () => configOptions,
    async sessionNew(cwd: string) {
      const resp = await sendRequest('session/new', { cwd, mcpServers: [] }, 120000);
      const result = resp.result as Record<string, unknown>;
      const sid = result?.sessionId as string;
      if (!sid) throw new Error('No sessionId');
      sessionId = sid;
      configOptions = parseConfigOptions(result);
      return sid;
    },
    async sessionLoad(sid: string, cwd: string) {
      const resp = await sendRequest('session/load', { sessionId: sid, cwd }, 120000);
      sessionId = sid;
      const result = resp.result as Record<string, unknown>;
      if (result) configOptions = parseConfigOptions(result);
      return sid;
    },
    async setConfigOption(configId: string, value: string) {
      if (!sessionId) throw new Error('No session');
      for (const opt of configOptions) { if (opt.id === configId) opt.currentValue = value; }
      try {
        const resp = await sendRequest('session/set_config_option', { sessionId, configId, value });
        const result = resp.result as Record<string, unknown>;
        if (result) configOptions = parseConfigOptions(result);
        logger.info('Config option set', { configId, value });
      } catch {
        // Fallback: send as slash command prompt (same as OpenABWindows)
        const cmd = `/${configId} ${value}`;
        logger.info('Fallback: sending as prompt', { cmd });
        await sendRequest('session/prompt', { sessionId, prompt: [{ type: 'text', text: cmd }] }, 30000);
      }
    },
    async sendPrompt(content: ContentBlock[], onEvent: (event: AcpEvent) => void): Promise<string> {
      if (!sessionId) throw new Error('No session');
      const id = nextId++;
      const line = makeRequest(id, 'session/prompt', { sessionId, prompt: content });
      let fullText = '';
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { promptSubscriber = null; pending.delete(id); reject(new Error('Prompt timeout (10min)')); }, 600000);
        promptSubscriber = (msg) => {
          if (msg.error && msg.id === undefined) { clearTimeout(timer); promptSubscriber = null; reject(new Error(msg.error.message)); return; }
          if (msg.id === id) { clearTimeout(timer); promptSubscriber = null; if (msg.error) reject(new Error(msg.error.message)); else { onEvent({ type: 'turn_end' }); resolve(fullText); } return; }
          const event = classifyNotification(msg);
          if (event) { if (event.type === 'text') fullText += event.content; onEvent(event); }
        };
        pending.set(id, { resolve: () => {}, reject: (err) => { clearTimeout(timer); promptSubscriber = null; reject(err); } });
        writeLine(line).catch((err) => { clearTimeout(timer); promptSubscriber = null; pending.delete(id); reject(err); });
      });
    },
    cancel() { if (!sessionId) return; writeLine(makeRequest(nextId++, 'session/cancel', { sessionId })).catch(() => {}); },
    onClose(cb: (code: number | null) => void) { closeCallback = cb; },
  };
}
