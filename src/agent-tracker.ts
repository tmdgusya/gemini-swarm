import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type AgentRole = 'researcher' | 'coder' | 'reviewer' | 'generalist';
export type AgentStatus = 'spawning' | 'running' | 'completed' | 'failed' | 'killed';

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

const WORK_DIR = '/tmp/gemini-swarm';

export class AgentTracker {
  private agents: Map<string, TrackedAgent> = new Map();
  private resultsDir: string;

  constructor(workDir: string = WORK_DIR) {
    this.resultsDir = join(workDir, 'results');
    mkdirSync(this.resultsDir, { recursive: true });
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
    return agent;
  }

  updateStatus(name: string, status: AgentStatus, extra?: Partial<TrackedAgent>): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    agent.status = status;
    if (extra) Object.assign(agent, extra);
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      agent.completedAt = new Date().toISOString();
      agent.durationMs = Date.now() - new Date(agent.startedAt).getTime();
      if (status === 'completed' && agent.response) {
        this.saveResult(agent);
      }
    }
  }

  getAgent(name: string): TrackedAgent | undefined {
    return this.agents.get(name);
  }

  getAllAgents(): TrackedAgent[] {
    return Array.from(this.agents.values());
  }

  getRunningAgents(): TrackedAgent[] {
    return this.getAllAgents().filter(a => a.status === 'spawning' || a.status === 'running');
  }

  removeAgent(name: string): void {
    this.agents.delete(name);
  }

  clearAll(): void {
    this.agents.clear();
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
    return files.map(f => {
      const data = readFileSync(join(this.resultsDir, f), 'utf-8');
      return JSON.parse(data) as AgentResult;
    });
  }

  getResultByTaskId(taskId: string): AgentResult | null {
    const filePath = join(this.resultsDir, `${taskId}.json`);
    if (!existsSync(filePath)) return null;
    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as AgentResult;
  }
}
