import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/coord-server.ts
import { createServer } from "node:http";
import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, renameSync, readFileSync as readFileSync2, existsSync as existsSync2, unlinkSync as unlinkSync2, appendFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath, join as join3 } from "node:path";

// src/lock-manager.ts
import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join as join2 } from "node:path";
import { createHash } from "node:crypto";

// src/types.ts
import * as path from "path";
function getWorkDir() {
  const envVal = process.env["SWARM_WORK_DIR"];
  if (envVal !== void 0) {
    const resolved = path.resolve(envVal);
    return resolved;
  }
  return path.join(process.cwd(), ".swarm");
}
var WORK_DIR = getWorkDir();
var COORD_PORT_FILE = path.join(WORK_DIR, "server.port");
var TASKBOARD_FILE = path.join(WORK_DIR, "taskboard.json");
var AGENTS_FILE = path.join(WORK_DIR, "coord-agents.json");
var INBOX_DIR = path.join(WORK_DIR, "inbox");

// src/lock-manager.ts
var LockManager = class {
  lockDir;
  constructor(lockDir = join2(WORK_DIR, "locks")) {
    this.lockDir = lockDir;
    mkdirSync(this.lockDir, { recursive: true });
  }
  /**
   * Tries to acquire a lock for a given resource.
   * @param resourceId A unique identifier for the resource (e.g., a file path).
   * @param owner The name of the agent or process requesting the lock.
   * @param ttlMs Optional Time To Live in milliseconds. If provided, the lock will expire after this time.
   * @returns true if the lock was acquired, false otherwise.
   */
  acquireLock(resourceId, owner, ttlMs) {
    const lockFilePath = this.getLockFilePath(resourceId);
    try {
      const lockInfo = {
        owner,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (ttlMs) {
        lockInfo.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      }
      writeFileSync(lockFilePath, JSON.stringify(lockInfo), { flag: "wx" });
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      try {
        const data = readFileSync(lockFilePath, "utf-8");
        const existingInfo = JSON.parse(data);
        if (existingInfo.owner === owner) {
          const updatedInfo = {
            ...existingInfo,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : void 0
          };
          writeFileSync(lockFilePath, JSON.stringify(updatedInfo));
          return true;
        }
        if (existingInfo.expiresAt && /* @__PURE__ */ new Date() > new Date(existingInfo.expiresAt)) {
          try {
            unlinkSync(lockFilePath);
          } catch (unlinkErr) {
          }
          return this.acquireOneTime(lockFilePath, owner, ttlMs);
        }
        return false;
      } catch (readErr) {
        return this.acquireOneTime(lockFilePath, owner, ttlMs);
      }
    }
  }
  /**
   * Internal helper for a single retry attempt.
   */
  acquireOneTime(lockFilePath, owner, ttlMs) {
    try {
      const lockInfo = {
        owner,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (ttlMs) {
        lockInfo.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      }
      writeFileSync(lockFilePath, JSON.stringify(lockInfo), { flag: "wx" });
      return true;
    } catch (err) {
      return false;
    }
  }
  /**
   * Releases a lock if it's owned by the specified owner.
   * @param resourceId The unique identifier for the resource.
   * @param owner The name of the agent or process that owns the lock.
   * @returns true if the lock was released, false if it wasn't owned by the caller.
   */
  releaseLock(resourceId, owner) {
    const lockFilePath = this.getLockFilePath(resourceId);
    try {
      const data = readFileSync(lockFilePath, "utf-8");
      const lockInfo = JSON.parse(data);
      if (lockInfo.owner !== owner) return false;
      unlinkSync(lockFilePath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      console.error(`[lock-manager] Failed to release lock ${resourceId}: ${err.message}`);
      return false;
    }
  }
  /**
   * Checks if a resource is currently locked.
   * @param resourceId The unique identifier for the resource.
   */
  isLocked(resourceId) {
    const lockFilePath = this.getLockFilePath(resourceId);
    if (!existsSync(lockFilePath)) {
      return false;
    }
    try {
      const data = readFileSync(lockFilePath, "utf-8");
      const lockInfo = JSON.parse(data);
      if (lockInfo.expiresAt) {
        return /* @__PURE__ */ new Date() <= new Date(lockInfo.expiresAt);
      }
      return true;
    } catch (err) {
      return false;
    }
  }
  /**
   * Executes a function while holding a lock.
   * @param resourceId The unique identifier for the resource.
   * @param owner The name of the agent or process requesting the lock.
   * @param fn The function to execute.
   * @param ttlMs Optional TTL for the lock.
   * @returns The result of the function if lock was acquired, or undefined otherwise.
   */
  async withLock(resourceId, owner, fn, ttlMs) {
    const acquired = this.acquireLock(resourceId, owner, ttlMs);
    if (!acquired) {
      return void 0;
    }
    try {
      return await fn();
    } finally {
      this.releaseLock(resourceId, owner);
    }
  }
  getLockFilePath(resourceId) {
    const hash = createHash("sha256").update(resourceId).digest("hex");
    return join2(this.lockDir, `${hash}.lock`);
  }
};

// src/coord-server.ts
var PORT_FILE = COORD_PORT_FILE;
var HEARTBEAT_INTERVAL_MS = 15e3;
var HEARTBEAT_DEAD_MS = 6e4;
var MAX_QUEUE_SIZE = 1e3;
var tasks = /* @__PURE__ */ new Map();
var agents = /* @__PURE__ */ new Map();
var messageQueues = /* @__PURE__ */ new Map();
var lockManager;
var startTime;
var healthInterval;
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp`;
  writeFileSync2(tmp, data, "utf-8");
  renameSync(tmp, filePath);
}
function saveTasks() {
  const arr = Array.from(tasks.values());
  atomicWrite(TASKBOARD_FILE, JSON.stringify(arr, null, 2));
}
function loadTasks() {
  if (!existsSync2(TASKBOARD_FILE)) return;
  try {
    const data = readFileSync2(TASKBOARD_FILE, "utf-8");
    const arr = JSON.parse(data);
    for (const t of arr) {
      tasks.set(t.id, t);
    }
  } catch {
  }
}
function saveAgents() {
  const arr = Array.from(agents.values());
  atomicWrite(AGENTS_FILE, JSON.stringify(arr, null, 2));
}
function loadAgents() {
  if (!existsSync2(AGENTS_FILE)) return;
  try {
    const data = readFileSync2(AGENTS_FILE, "utf-8");
    const arr = JSON.parse(data);
    for (const a of arr) {
      agents.set(a.name, a);
    }
  } catch {
  }
}
function loadMessages() {
  if (!existsSync2(INBOX_DIR)) {
    mkdirSync2(INBOX_DIR, { recursive: true });
    return;
  }
  try {
    const files = readdirSync(INBOX_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const agentName = file.replace(".jsonl", "");
      const content = readFileSync2(join3(INBOX_DIR, file), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const queue = [];
      for (const line of lines) {
        try {
          queue.push(JSON.parse(line));
        } catch {
        }
      }
      messageQueues.set(agentName, queue.slice(-MAX_QUEUE_SIZE));
    }
  } catch {
  }
}
function saveMessage(agentName, msg) {
  if (!existsSync2(INBOX_DIR)) {
    mkdirSync2(INBOX_DIR, { recursive: true });
  }
  const filePath = join3(INBOX_DIR, `${agentName}.jsonl`);
  appendFileSync(filePath, JSON.stringify(msg) + "\n");
}
function healthCheckLoop() {
  const now = Date.now();
  for (const agent of agents.values()) {
    if (agent.status === "dead") continue;
    const last = new Date(agent.lastHeartbeatAt).getTime();
    if (now - last > HEARTBEAT_DEAD_MS) {
      agent.status = "dead";
      for (const task of tasks.values()) {
        if (task.status === "claimed" && task.claimedBy === agent.name) {
          task.status = "open";
          task.claimedBy = void 0;
          task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        }
      }
      saveTasks();
      saveAgents();
    }
  }
}
function corsOrigin(req) {
  const origin = req.headers.origin;
  return origin && origin.startsWith("http://localhost") ? origin : "http://localhost";
}
function readBody(req) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
var _currentReq;
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": _currentReq ? corsOrigin(_currentReq) : "http://localhost",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(payload);
}
async function parseBody(req, res) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return null;
  }
}
function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(url.slice(idx + 1));
}
function pathname(url) {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}
async function handleRequest(req, res) {
  _currentReq = req;
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const path2 = pathname(rawUrl);
  const query = parseQuery(rawUrl);
  if (method === "OPTIONS") {
    const headers = {
      "Access-Control-Allow-Origin": corsOrigin(req),
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (method === "GET" && path2 === "/health") {
    const taskArr = Array.from(tasks.values());
    const health = {
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1e3),
      agents: agents.size,
      tasks: {
        open: taskArr.filter((t) => t.status === "open").length,
        claimed: taskArr.filter((t) => t.status === "claimed").length,
        completed: taskArr.filter((t) => t.status === "completed").length,
        failed: taskArr.filter((t) => t.status === "failed").length
      }
    };
    json(res, 200, health);
    return;
  }
  if (method === "POST" && path2 === "/tasks") {
    const body = await parseBody(req, res);
    if (!body) return;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const created = [];
    for (const t of body.tasks) {
      const task = {
        id: t.id,
        description: t.description,
        phase: t.phase,
        prompt: t.prompt,
        status: "open",
        metadata: t.metadata,
        createdAt: now,
        updatedAt: now
      };
      tasks.set(task.id, task);
      created.push(task);
    }
    saveTasks();
    json(res, 201, created);
    return;
  }
  if (method === "GET" && path2 === "/tasks") {
    let result = Array.from(tasks.values());
    const statusFilter = query.get("status");
    if (statusFilter) {
      result = result.filter((t) => t.status === statusFilter);
    }
    const phaseFilter = query.get("phase");
    if (phaseFilter) {
      const p = Number(phaseFilter);
      result = result.filter((t) => t.phase === p);
    }
    json(res, 200, result);
    return;
  }
  const taskMatch = path2.match(/^\/tasks\/([^/]+)(\/(?:claim|complete|fail))?$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const action = taskMatch[2];
    if (method === "GET" && !action) {
      const task = tasks.get(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      json(res, 200, task);
      return;
    }
    if (method === "POST" && action === "/claim") {
      const task = tasks.get(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      if (task.status !== "open") {
        json(res, 409, { error: `Task status is '${task.status}', cannot claim` });
        return;
      }
      const body = await parseBody(req, res);
      if (!body) return;
      task.status = "claimed";
      task.claimedBy = body.agent;
      task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveTasks();
      json(res, 200, task);
      return;
    }
    if (method === "POST" && action === "/complete") {
      const task = tasks.get(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      const body = await parseBody(req, res);
      if (!body) return;
      task.status = "completed";
      task.result = body.result;
      task.sha = body.sha;
      task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveTasks();
      json(res, 200, task);
      return;
    }
    if (method === "POST" && action === "/fail") {
      const task = tasks.get(taskId);
      if (!task) {
        json(res, 404, { error: "Task not found" });
        return;
      }
      const body = await parseBody(req, res);
      if (!body) return;
      task.status = "failed";
      task.error = body.error;
      task.claimedBy = void 0;
      task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      saveTasks();
      json(res, 200, task);
      return;
    }
  }
  if (method === "POST" && path2 === "/agents/register") {
    const body = await parseBody(req, res);
    if (!body) return;
    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      json(res, 400, { error: "Agent name is required" });
      return;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const agent = {
      name: body.name,
      role: body.role ?? "generalist",
      status: "idle",
      paneId: body.paneId,
      pid: body.pid,
      registeredAt: now,
      lastHeartbeatAt: now
    };
    agents.set(agent.name, agent);
    saveAgents();
    json(res, 200, agent);
    return;
  }
  if (method === "POST" && path2 === "/agents/heartbeat") {
    const body = await parseBody(req, res);
    if (!body) return;
    const agent = agents.get(body.name);
    if (!agent) {
      json(res, 404, { error: "Agent not found" });
      return;
    }
    agent.lastHeartbeatAt = (/* @__PURE__ */ new Date()).toISOString();
    if (agent.status === "dead") {
      agent.status = "idle";
    }
    saveAgents();
    json(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && path2 === "/agents") {
    json(res, 200, Array.from(agents.values()));
    return;
  }
  if (method === "POST" && path2 === "/messages") {
    const body = await parseBody(req, res);
    if (!body) return;
    const msg = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from: body.from,
      to: body.to,
      type: body.type,
      payload: body.payload,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (!messageQueues.has(body.to)) {
      messageQueues.set(body.to, []);
    }
    const queue = messageQueues.get(body.to);
    if (queue.length >= MAX_QUEUE_SIZE) {
      queue.splice(0, queue.length - MAX_QUEUE_SIZE + 1);
    }
    queue.push(msg);
    saveMessage(body.to, msg);
    json(res, 200, msg);
    return;
  }
  const msgMatch = path2.match(/^\/messages\/([^/]+)$/);
  if (method === "GET" && msgMatch) {
    const agentName = msgMatch[1];
    const since = Number(query.get("since") ?? "0");
    const queue = messageQueues.get(agentName) ?? [];
    const messages = queue.slice(since);
    json(res, 200, { messages, nextOffset: queue.length });
    return;
  }
  if (method === "POST" && path2 === "/locks") {
    const body = await parseBody(req, res);
    if (!body) return;
    const acquired = lockManager.acquireLock(body.resource, body.owner, body.ttlMs);
    if (acquired) {
      json(res, 200, { acquired: true });
    } else {
      json(res, 409, { acquired: false, error: "Lock already held" });
    }
    return;
  }
  const lockMatch = path2.match(/^\/locks\/(.+)$/);
  if (method === "DELETE" && lockMatch) {
    const resource = decodeURIComponent(lockMatch[1]);
    const body = await parseBody(req, res);
    if (!body) return;
    const released = lockManager.releaseLock(resource, body.owner);
    json(res, 200, { released });
    return;
  }
  json(res, 404, { error: "Not found" });
}
function startCoordServer() {
  return new Promise((resolve2, reject) => {
    try {
      mkdirSync2(WORK_DIR, { recursive: true, mode: 448 });
      const testFile = join3(WORK_DIR, ".write-test-server");
      writeFileSync2(testFile, "ok");
      unlinkSync2(testFile);
    } catch (err) {
      const message = `Coordination directory ${WORK_DIR} is not writable: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[coord] ${message}`);
      reject(new Error(message));
      return;
    }
    lockManager = new LockManager(join3(WORK_DIR, "locks"));
    startTime = Date.now();
    loadTasks();
    loadAgents();
    loadMessages();
    const server = createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: message });
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      writeFileSync2(PORT_FILE, `${port}
${process.pid}`, "utf-8");
      console.error(`[coord] Listening on port ${port}`);
      healthInterval = setInterval(healthCheckLoop, HEARTBEAT_INTERVAL_MS);
      healthInterval.unref();
      const shutdown = () => {
        if (healthInterval) {
          clearInterval(healthInterval);
          healthInterval = void 0;
        }
        try {
          unlinkSync2(PORT_FILE);
        } catch {
        }
        server.close();
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      resolve2(server);
    });
  });
}
var __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolvePath(process.argv[1]) === __filename) {
  startCoordServer();
}
export {
  startCoordServer
};
