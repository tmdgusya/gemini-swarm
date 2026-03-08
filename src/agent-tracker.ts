import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORK_DIR } from './types.js';

export type AgentRole = 'researcher' | 'coder' | 'reviewer' | 'generalist';
export type AgentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'killed' | 'unresponsive';

export interface TrackedAgent {
  name: string;
  role: AgentRole;
  status: AgentStatus;
  taskId: string;
  prompt: string;
  paneId?: string;
  pid?: number;
  startedAt: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  response?: string;
  error?: string;
  durationMs?: number;
}

export interface AgentResult {
  taskId: string;
  agent: string;
  response: string;
  duration: number;
  completedAt: string;
}

export class AgentTracker {
  private agents: Map<string, TrackedAgent> = new Map();
  private resultsDir: string;
  private stateFile: string;

  constructor(workDir: string = WORK_DIR) {
    this.resultsDir = join(workDir, 'results');
    this.stateFile = join(workDir, 'agents.json');
    mkdirSync(this.resultsDir, { recursive: true });
    this.load();
  }

  save(): void {
    const agents = Array.from(this.agents.values());
    const tmpFile = `${this.stateFile}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(agents, null, 2));
    renameSync(tmpFile, this.stateFile);
  }

  load(): void {
    if (existsSync(this.stateFile)) {
      try {
        const data = readFileSync(this.stateFile, 'utf-8');
        const agents: TrackedAgent[] = JSON.parse(data);
        this.agents = new Map(agents.map(a => [a.name, a]));
      } catch (err) {
        console.error(`Failed to load agent state: ${err}`);
      }
    }
  }

  register(opts: {
    name: string;
    role: AgentRole;
    prompt: string;
    paneId?: string;
    pid?: number;
  }): TrackedAgent {
    const taskId = `task-${randomUUID().slice(0, 8)}`;
    const agent: TrackedAgent = {
      name: opts.name,
      role: opts.role,
      status: 'spawning',
      taskId,
      prompt: opts.prompt,
      paneId: opts.paneId,
      pid: opts.pid,
      startedAt: new Date().toISOString(),
    };
    this.agents.set(opts.name, agent);
    this.save();
    return agent;
  }

  updateStatus(name: string, status: AgentStatus, extra?: Partial<TrackedAgent>): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    agent.status = status;
    if (extra) {
      const { response, error, pid, paneId } = extra;
      Object.assign(agent, {
        ...(response !== undefined && { response }),
        ...(error !== undefined && { error }),
        ...(pid !== undefined && { pid }),
        ...(paneId !== undefined && { paneId }),
      });
    }
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      agent.completedAt = new Date().toISOString();
      agent.durationMs = Date.now() - new Date(agent.startedAt).getTime();
      if (status === 'completed' && agent.response) {
        this.saveResult(agent);
      }
    }
    this.save();
  }

  updateHeartbeat(name: string): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    agent.lastHeartbeatAt = new Date().toISOString();
    // If it was unresponsive, bring it back
    if (agent.status === 'unresponsive') {
      agent.status = 'running';
    }
    this.save();
  }

  checkHealth(timeoutMs: number): string[] {
    const now = Date.now();
    const unresponsive: string[] = [];

    for (const agent of this.agents.values()) {
      if (agent.status !== 'running' && agent.status !== 'spawning' && agent.status !== 'unresponsive') {
        continue;
      }

      const lastHb = agent.lastHeartbeatAt
        ? new Date(agent.lastHeartbeatAt).getTime()
        : new Date(agent.startedAt).getTime();

      if (now - lastHb > timeoutMs) {
        if (agent.status !== 'unresponsive') {
          agent.status = 'unresponsive';
          unresponsive.push(agent.name);
        }
      }
    }

    if (unresponsive.length > 0) {
      this.save();
    }

    return unresponsive;
  }

  getAgent(name: string): TrackedAgent | undefined {
    return this.agents.get(name);
  }

  getAllAgents(): TrackedAgent[] {
    return Array.from(this.agents.values());
  }

  getRunningAgents(): TrackedAgent[] {
    return this.getAllAgents().filter(a => a.status === 'spawning' || a.status === 'running' || a.status === 'unresponsive');
  }

  removeAgent(name: string): void {
    this.agents.delete(name);
    this.save();
  }

  clearAll(): void {
    this.agents.clear();
    this.save();
  }

  private saveResult(agent: TrackedAgent): void {
    const result: AgentResult = {
      taskId: agent.taskId,
      agent: agent.name,
      response: agent.response ?? '',
      duration: agent.durationMs ?? 0,
      completedAt: agent.completedAt ?? new Date().toISOString(),
    };
    writeFileSync(
      join(this.resultsDir, `${agent.taskId}.json`),
      JSON.stringify(result, null, 2)
    );
  }

  getResults(): AgentResult[] {
    if (!existsSync(this.resultsDir)) return [];
    const files = readdirSync(this.resultsDir).filter(f => f.endsWith('.json'));
    const results: AgentResult[] = [];
    for (const f of files) {
      try {
        const data = readFileSync(join(this.resultsDir, f), 'utf-8');
        results.push(JSON.parse(data) as AgentResult);
      } catch {
        console.error(`[agent-tracker] Failed to read result file: ${f}, skipping`);
      }
    }
    return results;
  }

  getResultByTaskId(taskId: string): AgentResult | null {
    const filePath = join(this.resultsDir, `${taskId}.json`);
    if (!existsSync(filePath)) return null;
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as AgentResult;
  }
}
