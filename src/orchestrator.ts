/**
 * Orchestrator — event-driven master loop with inbox + wiki integration.
 * Master only wakes when inbox has new events AND master is idle.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type SessionManager } from './sessionManager.js';
import { type AcpEvent } from './acpProtocol.js';
import { logger } from './logger.js';

export interface InboxEvent {
  timestamp: string;
  from: string;
  summary: string;
  fullText?: string;
  savedTo?: string;
  image?: { media_type: string; data: string };
}

export interface Orchestrator {
  pushUserMessage(text: string, image?: { media_type: string; data: string }): void;
  pushWorkerReport(workerId: string, workerName: string, text: string): void;
  abort(): void;
}

const MAX_SUMMARY_LEN = 300;
const MAX_ROUNDS_PER_MIN = 10;
const DEBOUNCE_MS = 1500; // Wait 1.5s after last event before waking master

export function createOrchestrator(
  sm: SessionManager,
  onEvent: (agentId: string, event: AcpEvent) => void,
  onBroadcastSessions: () => void,
): Orchestrator {
  const inbox: InboxEvent[] = [];
  let processing = false;
  let aborted = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let roundsThisMinute = 0;
  let minuteResetTimer: ReturnType<typeof setInterval> | null = null;

  // Reset round counter every minute
  minuteResetTimer = setInterval(() => { roundsThisMinute = 0; }, 60000);

  function now() { return new Date().toISOString().slice(11, 19); }

  function saveToWiki(agentId: string, content: string, label: string): string {
    const dir = sm.get('master')?.wikiDir;
    if (!dir) return '';
    const reportsDir = resolve(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const filename = `${new Date().toISOString().slice(0, 10)}-${agentId}-${Date.now()}.md`;
    const filepath = resolve(reportsDir, filename);
    writeFileSync(filepath, `# ${label}\n\n${content}\n`);
    return filepath;
  }

  function summarize(text: string): string {
    if (text.length <= MAX_SUMMARY_LEN) return text;
    return text.slice(0, MAX_SUMMARY_LEN) + '...（詳見 wiki）';
  }

  function scheduleWake() {
    if (processing) return; // master busy, will check inbox when done
    if (inbox.length === 0) return;
    // Debounce: wait a bit for more events to batch
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => wakeMaster(), DEBOUNCE_MS);
  }

  async function wakeMaster() {
    if (processing || inbox.length === 0) return;
    const master = sm.get('master');
    if (!master || master.status !== 'idle') return;

    // Rate limit
    if (roundsThisMinute >= MAX_ROUNDS_PER_MIN) {
      onEvent('system', { type: 'text', content: '⚠️ Master 過於頻繁，暫停 10 秒...' });
      await new Promise(r => setTimeout(r, 10000));
      roundsThisMinute = 0;
    }

    processing = true;
    roundsThisMinute++;
    aborted = false;

    // Drain inbox
    const events = inbox.splice(0);

    // Collect images from events
    const images = events.filter(e => e.image).map(e => e.image!);
    if (images.length) logger.info('Orchestrator: passing images to master', { count: images.length });

    // Build prompt for master
    const workers = sm.getAll().filter(s => s.config.role === 'worker');
    const statusLines = workers.map(w => `- ${w.config.name} (${w.config.id}): ${w.status}`).join('\n');
    const eventLines = events.map(e => `[${e.timestamp}] ${e.from}: ${e.summary}${e.savedTo ? ` (full: ${e.savedTo})` : ''}${e.image ? ' [+image]' : ''}`).join('\n');

    const prompt = `[Worker Status]\n${statusLines}\n\n[New Events - ${events.length}]\n${eventLines}\n\n[Rules]\n1. Reply to user: write directly\n2. Dispatch: DISPATCH worker-id: task\n3. Need details: read wiki files\n4. All done: end with DONE`;

    try {
      const response = await sm.sendPrompt('master', prompt, onEvent, images.length ? images : undefined);
      if (aborted) { processing = false; return; }

      // Parse DISPATCH commands (multi-line: content until next DISPATCH/DONE/end)
      const parts = response.split(/^(?=DISPATCH\s)/m);
      for (const part of parts) {
        const m = part.match(/^DISPATCH\s+([\w-]+):\s*([\s\S]*)/);
        if (!m) continue;
        const wId = m[1];
        // Task = everything after "DISPATCH id:" until DONE or end, trimmed
        const task = m[2].replace(/\bDONE\s*$/, '').trim();
        if (!task) continue;
        const worker = sm.get(wId);
        if (worker && worker.status === 'idle') {
          executeWorker(wId, task);
        }
      }
    } catch (err) {
      if (!aborted) onEvent('system', { type: 'text', content: `❌ Master error: ${(err as Error).message}` });
    }

    processing = false;
    onBroadcastSessions();

    // Check if more events arrived while processing
    if (inbox.length > 0 && !aborted) scheduleWake();
  }

  async function executeWorker(workerId: string, task: string) {
    // Show dispatch in UI (appears in worker's channel)
    onEvent(workerId, { type: 'text', content: `📋 Task from Master:\n${task}` });
    onBroadcastSessions();
    try {
      const result = await sm.sendPrompt(workerId, task, onEvent);
      const worker = sm.get(workerId);
      const name = worker?.config.name ?? workerId;

      // Save long results to wiki, give master a summary
      let summary = summarize(result);
      let savedTo: string | undefined;
      if (result.length > MAX_SUMMARY_LEN) {
        savedTo = saveToWiki(workerId, result, `${name} 任務回報`);
        summary = summarize(result);
      }

      // Push to inbox for master to process
      inbox.push({ timestamp: now(), from: name, summary, fullText: result, savedTo });
      scheduleWake();
    } catch (err) {
      inbox.push({ timestamp: now(), from: workerId, summary: `❌ 錯誤: ${(err as Error).message}` });
      scheduleWake();
    }
    onBroadcastSessions();
  }

  return {
    pushUserMessage(text: string, image?: { media_type: string; data: string }) {
      inbox.push({ timestamp: now(), from: 'user', summary: text, image });
      scheduleWake();
    },

    pushWorkerReport(workerId: string, workerName: string, text: string) {
      let summary = summarize(text);
      let savedTo: string | undefined;
      if (text.length > MAX_SUMMARY_LEN) {
        savedTo = saveToWiki(workerId, text, `${workerName} 回報`);
      }
      inbox.push({ timestamp: now(), from: workerName, summary, savedTo });
      scheduleWake();
    },

    abort() {
      aborted = true;
      inbox.length = 0;
      sm.get('master')?.backend?.cancel();
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    },
  };
}
