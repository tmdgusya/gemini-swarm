import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, unlinkSync, appendFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, join } from 'node:path';
import { LockManager } from './lock-manager.js';
import { WORK_DIR, COORD_PORT_FILE, TASKBOARD_FILE, AGENTS_FILE, INBOX_DIR } from './types.js';
import type {
  SwarmTask,
  CreateTasksRequest,
  ClaimTaskRequest,
  CompleteTaskRequest,
  FailTaskRequest,
  SwarmAgent,
  RegisterAgentRequest,
  HeartbeatRequest,
  SwarmMessage,
  SendMessageRequest,
  LockRequest,
  UnlockRequest,
  CoordHealth,
} from './types.js';

// ─── Constants ───

const PORT_FILE = COORD_PORT_FILE;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_DEAD_MS = 60_000;
const MAX_QUEUE_SIZE = 1000;

// ─── State ───

const tasks = new Map<string, SwarmTask>();
const agents = new Map<string, SwarmAgent>();
const messageQueues = new Map<string, SwarmMessage[]>();
let lockManager: LockManager;
let startTime: number;
let healthInterval: ReturnType<typeof setInterval> | undefined;

// ─── Persistence helpers ───

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function saveTasks(): void {
  const arr = Array.from(tasks.values());
  atomicWrite(TASKBOARD_FILE, JSON.stringify(arr, null, 2));
}

function loadTasks(): void {
  if (!existsSync(TASKBOARD_FILE)) return;
  try {
    const data = readFileSync(TASKBOARD_FILE, 'utf-8');
    const arr: SwarmTask[] = JSON.parse(data);
    for (const t of arr) {
      tasks.set(t.id, t);
    }
  } catch {
    // ignore corrupt file
  }
}

function saveAgents(): void {
  const arr = Array.from(agents.values());
  atomicWrite(AGENTS_FILE, JSON.stringify(arr, null, 2));
}

function loadAgents(): void {
  if (!existsSync(AGENTS_FILE)) return;
  try {
    const data = readFileSync(AGENTS_FILE, 'utf-8');
    const arr: SwarmAgent[] = JSON.parse(data);
    for (const a of arr) {
      agents.set(a.name, a);
    }
  } catch {
    // ignore corrupt file
  }
}

function loadMessages(): void {
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
    return;
  }
  try {
    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const agentName = file.replace('.jsonl', '');
      const content = readFileSync(join(INBOX_DIR, file), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const queue: SwarmMessage[] = [];
      for (const line of lines) {
        try {
          queue.push(JSON.parse(line));
        } catch { /* ignore */ }
      }
      messageQueues.set(agentName, queue.slice(-MAX_QUEUE_SIZE));
    }
  } catch {
    // ignore corrupt file
  }
}

function saveMessage(agentName: string, msg: SwarmMessage): void {
  if (!existsSync(INBOX_DIR)) {
    mkdirSync(INBOX_DIR, { recursive: true });
  }
  const filePath = join(INBOX_DIR, `${agentName}.jsonl`);
  appendFileSync(filePath, JSON.stringify(msg) + '\n');
}

// ─── Health check loop ───

function healthCheckLoop(): void {
  const now = Date.now();
  for (const agent of agents.values()) {
    if (agent.status === 'dead') continue;
    const last = new Date(agent.lastHeartbeatAt).getTime();
    if (now - last > HEARTBEAT_DEAD_MS) {
      agent.status = 'dead';
      // Release claimed tasks
      for (const task of tasks.values()) {
        if (task.status === 'claimed' && task.claimedBy === agent.name) {
          task.status = 'open';
          task.claimedBy = undefined;
          task.updatedAt = new Date().toISOString();
        }
      }
      saveTasks();
      saveAgents();
    }
  }
}

// ─── HTTP helpers ───

function corsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  return origin && origin.startsWith('http://localhost') ? origin : 'http://localhost';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

let _currentReq: IncomingMessage | undefined;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': _currentReq ? corsOrigin(_currentReq) : 'http://localhost',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

async function parseBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?');
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(idx + 1));
}

function pathname(url: string): string {
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

// ─── Route handlers ───

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  _currentReq = req;
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const path = pathname(rawUrl);
  const query = parseQuery(rawUrl);

  // CORS preflight
  if (method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': corsOrigin(req),
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    res.writeHead(204, headers);
    res.end();
    return;
  }

  // ─── Health ───
  if (method === 'GET' && path === '/health') {
    const taskArr = Array.from(tasks.values());
    const health: CoordHealth = {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      agents: agents.size,
      tasks: {
        open: taskArr.filter(t => t.status === 'open').length,
        claimed: taskArr.filter(t => t.status === 'claimed').length,
        completed: taskArr.filter(t => t.status === 'completed').length,
        failed: taskArr.filter(t => t.status === 'failed').length,
      },
    };
    json(res, 200, health);
    return;
  }

  // ─── Tasks ───

  // POST /tasks — create tasks
  if (method === 'POST' && path === '/tasks') {
    const body = await parseBody<CreateTasksRequest>(req, res);
    if (!body) return;
    const now = new Date().toISOString();
    const created: SwarmTask[] = [];
    for (const t of body.tasks) {
      const task: SwarmTask = {
        id: t.id,
        description: t.description,
        phase: t.phase,
        prompt: t.prompt,
        status: 'open',
        metadata: t.metadata,
        createdAt: now,
        updatedAt: now,
      };
      tasks.set(task.id, task);
      created.push(task);
    }
    saveTasks();
    json(res, 201, created);
    return;
  }

  // GET /tasks — list tasks
  if (method === 'GET' && path === '/tasks') {
    let result = Array.from(tasks.values());
    const statusFilter = query.get('status');
    if (statusFilter) {
      result = result.filter(t => t.status === statusFilter);
    }
    const phaseFilter = query.get('phase');
    if (phaseFilter) {
      const p = Number(phaseFilter);
      result = result.filter(t => t.phase === p);
    }
    json(res, 200, result);
    return;
  }

  // Task by ID routes: /tasks/:id, /tasks/:id/claim, /tasks/:id/complete, /tasks/:id/fail
  const taskMatch = path.match(/^\/tasks\/([^/]+)(\/(?:claim|complete|fail))?$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const action = taskMatch[2]; // undefined, /claim, /complete, /fail

    // GET /tasks/:id
    if (method === 'GET' && !action) {
      const task = tasks.get(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return; }
      json(res, 200, task);
      return;
    }

    // POST /tasks/:id/claim
    if (method === 'POST' && action === '/claim') {
      const task = tasks.get(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return; }
      if (task.status !== 'open') {
        json(res, 409, { error: `Task status is '${task.status}', cannot claim` });
        return;
      }
      const body = await parseBody<ClaimTaskRequest>(req, res);
      if (!body) return;
      task.status = 'claimed';
      task.claimedBy = body.agent;
      task.updatedAt = new Date().toISOString();
      saveTasks();
      json(res, 200, task);
      return;
    }

    // POST /tasks/:id/complete
    if (method === 'POST' && action === '/complete') {
      const task = tasks.get(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return; }
      const body = await parseBody<CompleteTaskRequest>(req, res);
      if (!body) return;
      task.status = 'completed';
      task.result = body.result;
      task.sha = body.sha;
      task.updatedAt = new Date().toISOString();
      saveTasks();
      json(res, 200, task);
      return;
    }

    // POST /tasks/:id/fail
    if (method === 'POST' && action === '/fail') {
      const task = tasks.get(taskId);
      if (!task) { json(res, 404, { error: 'Task not found' }); return; }
      const body = await parseBody<FailTaskRequest>(req, res);
      if (!body) return;
      task.status = 'failed';
      task.error = body.error;
      task.claimedBy = undefined;
      task.updatedAt = new Date().toISOString();
      saveTasks();
      json(res, 200, task);
      return;
    }
  }

  // ─── Agents ───

  if (method === 'POST' && path === '/agents/register') {
    const body = await parseBody<RegisterAgentRequest>(req, res);
    if (!body) return;
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      json(res, 400, { error: 'Agent name is required' });
      return;
    }
    const now = new Date().toISOString();
    const agent: SwarmAgent = {
      name: body.name,
      role: body.role ?? 'generalist',
      status: 'idle',
      paneId: body.paneId,
      pid: body.pid,
      registeredAt: now,
      lastHeartbeatAt: now,
    };
    agents.set(agent.name, agent);
    saveAgents();
    json(res, 200, agent);
    return;
  }

  if (method === 'POST' && path === '/agents/heartbeat') {
    const body = await parseBody<HeartbeatRequest>(req, res);
    if (!body) return;
    const agent = agents.get(body.name);
    if (!agent) { json(res, 404, { error: 'Agent not found' }); return; }
    agent.lastHeartbeatAt = new Date().toISOString();
    if (agent.status === 'dead') {
      agent.status = 'idle';
    }
    saveAgents();
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && path === '/agents') {
    json(res, 200, Array.from(agents.values()));
    return;
  }

  // ─── Messages ───

  if (method === 'POST' && path === '/messages') {
    const body = await parseBody<SendMessageRequest>(req, res);
    if (!body) return;
    const msg: SwarmMessage = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from: body.from,
      to: body.to,
      type: body.type,
      payload: body.payload,
      timestamp: new Date().toISOString(),
    };
    if (!messageQueues.has(body.to)) {
      messageQueues.set(body.to, []);
    }
    const queue = messageQueues.get(body.to)!;
    if (queue.length >= MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE + 1);
    }
    queue.push(msg);
    saveMessage(body.to, msg);
    json(res, 200, msg);
    return;
  }

  // GET /messages/:agent
  const msgMatch = path.match(/^\/messages\/([^/]+)$/);
  if (method === 'GET' && msgMatch) {
    const agentName = msgMatch[1];
    const since = Number(query.get('since') ?? '0');
    const queue = messageQueues.get(agentName) ?? [];
    const messages = queue.slice(since);
    json(res, 200, { messages, nextOffset: queue.length });
    return;
  }

  // ─── Locks ───

  if (method === 'POST' && path === '/locks') {
    const body = await parseBody<LockRequest>(req, res);
    if (!body) return;
    const acquired = lockManager.acquireLock(body.resource, body.owner, body.ttlMs);
    if (acquired) {
      json(res, 200, { acquired: true });
    } else {
      json(res, 409, { acquired: false, error: 'Lock already held' });
    }
    return;
  }

  const lockMatch = path.match(/^\/locks\/(.+)$/);
  if (method === 'DELETE' && lockMatch) {
    const resource = decodeURIComponent(lockMatch[1]);
    const body = await parseBody<UnlockRequest>(req, res);
    if (!body) return;
    const released = lockManager.releaseLock(resource, body.owner);
    json(res, 200, { released });
    return;
  }

  // ─── 404 ───
  json(res, 404, { error: 'Not found' });
}

// ─── Server startup ───

export function startCoordServer(): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    try {
      mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
      const testFile = join(WORK_DIR, '.write-test-server');
      writeFileSync(testFile, 'ok');
      unlinkSync(testFile);
    } catch (err) {
      const message = `Coordination directory ${WORK_DIR} is not writable: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.error(`[coord] ${message}`);
      reject(new Error(message));
      return;
    }

    lockManager = new LockManager(join(WORK_DIR, 'locks'));
    startTime = Date.now();

    // Load persisted state
    loadTasks();
    loadAgents();
    loadMessages();

    const server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: message });
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      writeFileSync(PORT_FILE, `${port}\n${process.pid}`, 'utf-8');
      console.error(`[coord] Listening on port ${port}`);

      // Start health check loop (unref so it doesn't prevent process exit)
      healthInterval = setInterval(healthCheckLoop, HEARTBEAT_INTERVAL_MS);
      healthInterval.unref();

      // Graceful shutdown
      const shutdown = () => {
        if (healthInterval) {
          clearInterval(healthInterval);
          healthInterval = undefined;
        }
        try { unlinkSync(PORT_FILE); } catch { /* ignore */ }
        server.close();
        process.exit(0);
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);

      resolve(server);
    });
  });
}

// ─── Standalone entry ───

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === __filename) {
  startCoordServer();
}
