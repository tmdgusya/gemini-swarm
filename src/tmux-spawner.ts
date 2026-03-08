import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { WORK_DIR } from './types.js';

export interface TmuxAgent {
  name: string;
  paneId: string;
  pid: number;
  process: ChildProcess;
}

export interface SpawnOptions {
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
  extraFlags?: string[];
}

export interface StreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'error';
  content?: string;
  response?: string;
  error?: string;
  role?: string;
  stats?: unknown;
}

export class TmuxSpawner {
  private hasTmux: boolean;
  private inTmux: boolean;
  private paneMap: Map<string, string> = new Map();
  private bgProcesses = new Map<string, ChildProcess>();

  constructor() {
    this.hasTmux = TmuxSpawner.checkTmux();
    this.inTmux = !!process.env['TMUX'];
  }

  private static checkTmux(): boolean {
    try {
      execSync('which tmux', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  get tmuxAvailable(): boolean {
    return this.hasTmux && this.inTmux;
  }

  static outputPath(name: string): string {
    return join(WORK_DIR, `output-${name}.jsonl`);
  }

  private channelName(name: string): string {
    return `swarm-${name}-done`;
  }

  spawn(opts: SpawnOptions): TmuxAgent {
    const args = ['-p', opts.prompt, '-y', '-o', 'stream-json'];
    if (opts.model) {
      args.push('-m', opts.model);
    }
    if (opts.extraFlags) {
      args.push(...opts.extraFlags);
    }

    if (this.tmuxAvailable) {
      return this.spawnInTmux(opts.name, args, opts.cwd);
    }
    return this.spawnBackground(opts.name, args, opts.cwd);
  }

  private spawnInTmux(name: string, args: string[], cwd: string): TmuxAgent {
    const geminiCmd = ['gemini', ...args.map(a => shellEscape(a))].join(' ');
    const outputFile = TmuxSpawner.outputPath(name);
    const channel = this.channelName(name);

    // Ensure the output directory exists
    mkdirSync(WORK_DIR, { recursive: true });

    // Truncate/create output file
    writeFileSync(outputFile, '');

    // Run gemini with tee (visible in pane), then signal completion via tmux wait-for
    // The ; chaining ensures wait-for -S runs even if gemini crashes
    const tmuxCmd = `SWARM_WORK_DIR=${shellEscape(WORK_DIR)} SWARM_AGENT_NAME=${shellEscape(name)} ${geminiCmd} 2>&1 | tee ${shellEscape(outputFile)}; tmux wait-for -S ${shellEscape(channel)}`;
    const paneId = execSync(
      `tmux split-window -h -d -P -F "#{pane_id}" -c ${shellEscape(cwd)} ${shellEscape(tmuxCmd)}`,
      { encoding: 'utf-8', stdio: 'pipe' }
    ).trim();

    // Get PID of the process in the new pane
    let pid = 0;
    try {
      const pidStr = execSync(
        `tmux list-panes -F "#{pane_id}\t#{pane_pid}" | grep "^${paneId}" | cut -f2`,
        { encoding: 'utf-8', stdio: 'pipe' }
      ).trim();
      pid = parseInt(pidStr, 10) || 0;
    } catch { /* ignore */ }

    // Track pane ID for later kill/list operations
    this.paneMap.set(name, paneId);

    // Wait for the tmux channel signal (replaces tail -f)
    // This process closes exactly when gemini finishes
    const waiter = spawn('tmux', ['wait-for', channel], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return { name, paneId, pid, process: waiter };
  }

  private spawnBackground(name: string, args: string[], cwd: string): TmuxAgent {
    const outputFile = TmuxSpawner.outputPath(name);
    writeFileSync(outputFile, '');
    const proc = spawn('gemini', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, SWARM_AGENT_NAME: name, SWARM_WORK_DIR: WORK_DIR },
    });
    proc.stdin?.end();
    // Pipe stdout/stderr to file to prevent buffer blocking
    const outStream = createWriteStream(outputFile, { flags: 'a' });
    outStream.on('error', (err) => {
      console.error(`[tmux-spawner] Failed to write to output file for ${name}:`, err.message);
    });
    proc.stdout?.pipe(outStream);
    proc.stderr?.pipe(outStream);
    this.bgProcesses.set(name, proc);
    return {
      name,
      paneId: `bg-${proc.pid}`,
      pid: proc.pid ?? 0,
      process: proc,
    };
  }

  kill(name: string): boolean {
    if (this.tmuxAvailable) {
      const paneId = this.paneMap.get(name);
      if (!paneId) return false;
      this.killPane(name, paneId);
      this.paneMap.delete(name);
      return true;
    }
    const proc = this.bgProcesses.get(name);
    if (proc?.pid) {
      try { process.kill(proc.pid); } catch { /* already dead */ }
      this.bgProcesses.delete(name);
      return true;
    }
    return false;
  }

  killAll(): string[] {
    const killed: string[] = [];
    if (this.tmuxAvailable) {
      for (const [name, paneId] of this.paneMap) {
        this.killPane(name, paneId);
        killed.push(name);
      }
      this.paneMap.clear();
    }
    for (const [name, proc] of this.bgProcesses) {
      if (proc.pid) {
        try { process.kill(proc.pid); } catch { /* already dead */ }
        killed.push(name);
      }
    }
    this.bgProcesses.clear();
    return killed;
  }

  removePaneEntry(name: string): void {
    this.paneMap.delete(name);
  }

  reRegister(name: string, paneId: string): void {
    this.paneMap.set(name, paneId);
  }

  getWaiter(name: string): ChildProcess {
    const channel = this.channelName(name);
    return spawn('tmux', ['wait-for', channel], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private killPane(name: string, paneId: string): void {
    try {
      execSync(`tmux kill-pane -t ${paneId}`, { stdio: 'pipe' });
    } catch { /* ignore */ }
    // Pane kill prevents the shell from running wait-for -S, so send signal manually
    try {
      execSync(`tmux wait-for -S ${shellEscape(this.channelName(name))}`, { stdio: 'pipe' });
    } catch { /* ignore */ }
  }

  listPanes(): Array<{ name: string; paneId: string; active: boolean }> {
    if (!this.tmuxAvailable) return [];

    // Get all live pane IDs in the current window
    const livePanes = new Set<string>();
    try {
      const output = execSync(
        'tmux list-panes -F "#{pane_id}\t#{pane_active}"',
        { encoding: 'utf-8', stdio: 'pipe' }
      ).trim();
      for (const line of output.split('\n')) {
        const id = line.split('\t')[0];
        if (id) livePanes.add(id);
      }
    } catch { /* ignore */ }

    const result: Array<{ name: string; paneId: string; active: boolean }> = [];
    for (const [name, paneId] of this.paneMap) {
      result.push({
        name,
        paneId,
        active: livePanes.has(paneId),
      });
    }
    return result;
  }

  spawnAgent(opts: { name: string; cwd: string; model?: string; extraFlags?: string[] }): TmuxAgent {
    // Spawn with a minimal bootstrap prompt that tells the agent to check the TaskBoard
    const bootstrapPrompt = `You are swarm agent "${opts.name}". Check available tasks with swarm_task_list, claim one with swarm_task_claim, execute it, then report with swarm_task_complete or swarm_task_fail. Repeat until no tasks remain, then exit.`;
    return this.spawn({ ...opts, prompt: bootstrapPrompt });
  }

  spawnMany(agents: Array<{ name: string; cwd: string; model?: string }>): TmuxAgent[] {
    const results: TmuxAgent[] = [];
    for (const opts of agents) {
      results.push(this.spawnAgent(opts));
    }
    if (this.tmuxAvailable) {
      this.applyTiledLayout();
    }
    return results;
  }

  applyTiledLayout(): void {
    if (!this.tmuxAvailable) return;
    try {
      execSync('tmux select-layout tiled', { stdio: 'pipe' });
    } catch { /* ignore */ }
  }

  static parseStreamEvents(raw: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          events.push(parsed as StreamEvent);
        }
      } catch { /* skip */ }
    }
    return events;
  }

  static extractResponse(events: StreamEvent[]): string {
    const resultEvent = events.find(e => e.type === 'result');
    if (resultEvent?.response) return resultEvent.response;

    return events
      .filter(e => e.type === 'message' && e.role === 'assistant' && e.content)
      .map(e => e.content!)
      .join('');
  }
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
