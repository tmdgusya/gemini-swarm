import * as path from 'path';

// ─── Shared types for Gemini Swarm coordination protocol ───

// ─── TaskBoard ───

export type TaskStatus = 'open' | 'claimed' | 'completed' | 'failed';

export interface SwarmTask {
  id: string;
  description: string;
  phase?: number;
  prompt: string;
  status: TaskStatus;
  claimedBy?: string;
  result?: string;
  error?: string;
  sha?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTasksRequest {
  tasks: Array<{
    id: string;
    description: string;
    phase?: number;
    prompt: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ClaimTaskRequest {
  agent: string;
}

export interface CompleteTaskRequest {
  agent: string;
  result: string;
  sha?: string;
}

export interface FailTaskRequest {
  agent: string;
  error: string;
}

// ─── Agents ───

export type AgentRole = 'researcher' | 'coder' | 'reviewer' | 'generalist';

export interface SwarmAgent {
  name: string;
  role: AgentRole;
  status: 'idle' | 'working' | 'done' | 'dead';
  currentTaskId?: string;
  paneId?: string;
  pid?: number;
  registeredAt: string;
  lastHeartbeatAt: string;
}

export interface RegisterAgentRequest {
  name: string;
  role?: AgentRole;
  paneId?: string;
  pid?: number;
}

export interface HeartbeatRequest {
  name: string;
}

// ─── Messages ───

export type MessageType = 'task' | 'result' | 'info' | 'error' | 'heartbeat' | 'ack';

export interface SwarmMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: string;
}

export interface SendMessageRequest {
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
}

// ─── Locks ───

export interface LockRequest {
  resource: string;
  owner: string;
  ttlMs?: number;
}

export interface UnlockRequest {
  owner: string;
}

export interface LockInfo {
  resource: string;
  owner: string;
  timestamp: string;
  expiresAt?: string;
}

// ─── Coordination Server ───

export function getWorkDir(): string {
  const envVal = process.env['SWARM_WORK_DIR'];
  if (envVal !== undefined) {
    const resolved = path.resolve(envVal);
    return resolved;
  }
  return path.join(process.cwd(), '.swarm');
}

export const WORK_DIR = getWorkDir();
export const COORD_PORT_FILE = path.join(WORK_DIR, 'server.port');
export const TASKBOARD_FILE = path.join(WORK_DIR, 'taskboard.json');
export const AGENTS_FILE = path.join(WORK_DIR, 'coord-agents.json');
export const INBOX_DIR = path.join(WORK_DIR, 'inbox');

export interface CoordHealth {
  status: 'ok';
  uptime: number;
  agents: number;
  tasks: { open: number; claimed: number; completed: number; failed: number };
}

// ─── REST API Contract ───
//
// POST   /tasks                 body: CreateTasksRequest     → SwarmTask[]
// GET    /tasks                 query: ?status=&phase=       → SwarmTask[]
// GET    /tasks/:id             → SwarmTask
// POST   /tasks/:id/claim       body: ClaimTaskRequest       → SwarmTask | 409
// POST   /tasks/:id/complete    body: CompleteTaskRequest     → SwarmTask
// POST   /tasks/:id/fail        body: FailTaskRequest         → SwarmTask
//
// POST   /agents/register       body: RegisterAgentRequest   → SwarmAgent
// POST   /agents/heartbeat      body: HeartbeatRequest       → {ok: true}
// GET    /agents                → SwarmAgent[]
//
// POST   /messages              body: SendMessageRequest     → SwarmMessage
// GET    /messages/:agent       query: ?since=offset         → SwarmMessage[]
//
// POST   /locks                 body: LockRequest            → {acquired: true} | 409
// DELETE /locks/:resource       body: UnlockRequest          → {released: true}
//
// GET    /health                → CoordHealth
