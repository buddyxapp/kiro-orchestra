/**
 * Kiro Orchestra — entry point.
 * Starts web server only. Agents are launched from the browser UI.
 */
import { createSessionManager } from './sessionManager.js';
import { startServer } from './wsServer.js';
import { logger } from './logger.js';

const PORT = parseInt(process.env.PORT ?? '3000');
const KIRO_CMD = process.env.KIRO_CMD ?? 'kiro-cli';
const KIRO_ARGS = (process.env.KIRO_ARGS ?? 'acp --trust-all-tools').split(' ');
const WORKSPACE = process.env.WORKSPACE ?? process.cwd();

function main() {
  logger.info('Starting Kiro Orchestra', { port: PORT, workspace: WORKSPACE });

  const sm = createSessionManager(KIRO_CMD, KIRO_ARGS, WORKSPACE);

  const defaultPersona = '你是一個工作助理。聽從指揮官和使用者的命令執行任務。你有一個 wiki 目錄可以用來累積知識，有用的資訊請寫入 wiki/ 中的 .md 檔案。';

  sm.addAgent({ id: 'master', name: '指揮官', role: 'master', persona: '你是任務指揮官。收到使用者指令後，分析需要做什麼，分派給可用的 workers。你有一個 wiki 目錄記錄分派歷史和策略。' });
  sm.addAgent({ id: 'worker-1', name: 'Worker 1', role: 'worker', persona: defaultPersona });
  sm.addAgent({ id: 'worker-2', name: 'Worker 2', role: 'worker', persona: defaultPersona });
  sm.addAgent({ id: 'worker-3', name: 'Worker 3', role: 'worker', persona: defaultPersona });
  sm.addAgent({ id: 'worker-4', name: 'Worker 4', role: 'worker', persona: defaultPersona });

  startServer(PORT, sm, WORKSPACE);

  const shutdown = () => { sm.stopAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
