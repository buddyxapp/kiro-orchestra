/**
 * Task Command Parser — extracts structured task commands from Master's response.
 * Master uses fixed English keywords; content can be any language.
 * Stage numbers in commands are 1-based; parser converts to 0-based.
 */

export type TaskCommand =
  | { type: 'create'; name: string; stages: string[] }
  | { type: 'update'; taskId: string; stageIndex: number; status: string }
  | { type: 'wait'; taskId: string; reason: string; actions?: string[] }
  | { type: 'done'; taskId: string }
  | { type: 'add_stage'; taskId: string; name: string }
  | { type: 'dispatch'; workerId: string; taskId?: string; stageIndex?: number; instructions: string };

export function parseTaskCommands(response: string): TaskCommand[] {
  const commands: TaskCommand[] = [];

  // TASK_CREATE name: xxx\nSTAGE: ...\nSTAGE: ...
  const createRegex = /^TASK_CREATE\s+name:\s*(.+)\n((?:STAGE:\s*.+\n?)+)/gm;
  let m: RegExpExecArray | null;
  while ((m = createRegex.exec(response)) !== null) {
    const name = m[1].trim();
    const stages = m[2].split('\n').filter(l => /^STAGE:\s*/.test(l)).map(l => l.replace(/^STAGE:\s*/, '').trim());
    if (name && stages.length) commands.push({ type: 'create', name, stages });
  }

  // TASK_UPDATE task-id: stage N → status
  const updateRegex = /^TASK_UPDATE\s+([\w-]+):\s*stage\s+(\d+)\s*(?:→|->)\s*(\w+)/gm;
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

  // TASK_ADD_STAGE task-id: stage name
  const addStageRegex = /^TASK_ADD_STAGE\s+([\w-]+):\s*(.+)$/gm;
  while ((m = addStageRegex.exec(response)) !== null) {
    commands.push({ type: 'add_stage', taskId: m[1], name: m[2].trim() });
  }

  // DISPATCH worker-id [task:xxx, stage:N]: instructions (multi-line until next command)
  const parts = response.split(/^(?=DISPATCH\s)/m);
  for (const part of parts) {
    const dm = part.match(/^DISPATCH\s+([\w-]+)(?:\s*\[task:([\w-]+),\s*stage:(\d+)\])?\s*:\s*([\s\S]*)/);
    if (!dm) continue;
    // Instructions end at next TASK_ command, DISPATCH, or DONE
    const rawInstructions = dm[4];
    const endMatch = rawInstructions.search(/^(?:TASK_|DISPATCH\s|DONE\s*$)/m);
    const instructions = (endMatch === -1 ? rawInstructions : rawInstructions.slice(0, endMatch)).trim();
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
