export interface SwarmConfig {
  maxAgents: number;
  workDir: string;
  useWorktrees: boolean;
  model?: string;
  geminiFlags?: string[];
  timeout?: number;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AgentRole = 'researcher' | 'coder' | 'reviewer' | 'generalist';
export type MessageType = 'task' | 'result' | 'info' | 'error' | 'heartbeat';

export interface Task {
  id: string;
  prompt: string;
  role: AgentRole;
  status: TaskStatus;
  assignedTo?: string;
  dependsOn?: string[];
  context?: string;
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  taskId: string;
  agent: string;
  status: 'completed' | 'failed';
  response: string;
  stats?: GeminiStats;
  error?: string;
  durationMs: number;
}

export interface GeminiStats {
  models: Array<{
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
  }>;
  tools: Array<{
    name: string;
    callCount: number;
  }>;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: string;
}

export interface AgentInfo {
  name: string;
  role: AgentRole;
  pid?: number;
  status: 'idle' | 'running' | 'stopped' | 'error';
  currentTask?: string;
  worktreePath?: string;
}

export interface GeminiStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'error';
  session_id?: string;
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: string;
  response?: string;
  stats?: GeminiStats;
  error?: string;
}
