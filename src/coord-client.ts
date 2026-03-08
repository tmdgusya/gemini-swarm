import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentRole,
  CoordHealth,
  CreateTasksRequest,
  MessageType,
  SwarmAgent,
  SwarmMessage,
  SwarmTask,
  TaskStatus,
} from './types.js';
import { COORD_PORT_FILE, WORK_DIR } from './types.js';

class CoordError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`${message} (HTTP ${status}): ${body}`);
    this.name = 'CoordError';
  }
}

export class CoordClient {
  constructor(private baseUrl: string) {}

  // ─── Internal helpers ───

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) {
        throw new CoordError(`${method} ${path} failed`, res.status, text);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (err: unknown) {
      if (err instanceof CoordError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to coordination server at ${this.baseUrl}. Please ensure the server is running. Error: ${message}`);
    }
  }

  /**
   * Like request(), but returns `null` instead of throwing on 409 Conflict.
   */
  private async requestOr409Null<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 409) return null;
      if (!res.ok) {
        throw new CoordError(`${method} ${path} failed`, res.status, text);
      }
      return text ? (JSON.parse(text) as T) : (undefined as T);
    } catch (err: unknown) {
      if (err instanceof CoordError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to coordination server at ${this.baseUrl}. Please ensure the server is running. Error: ${message}`);
    }
  }

  /**
   * Like request(), but returns a boolean derived from 409 status for lock ops.
   */
  private async requestOr409Bool(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<boolean> {
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (res.status === 409) return false;
      if (!res.ok) {
        throw new CoordError(`${method} ${path} failed`, res.status, text);
      }
      return true;
    } catch (err: unknown) {
      if (err instanceof CoordError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to connect to coordination server at ${this.baseUrl}. Please ensure the server is running. Error: ${message}`);
    }
  }

  // ─── TaskBoard ───

  async createTasks(tasks: CreateTasksRequest['tasks']): Promise<SwarmTask[]> {
    return this.request<SwarmTask[]>('POST', '/tasks', { tasks });
  }

  async listTasks(filter?: {
    status?: TaskStatus;
    phase?: number;
  }): Promise<SwarmTask[]> {
    const params = new URLSearchParams();
    if (filter?.status) params.set('status', filter.status);
    if (filter?.phase !== undefined) params.set('phase', String(filter.phase));
    const qs = params.toString();
    return this.request<SwarmTask[]>('GET', `/tasks${qs ? `?${qs}` : ''}`);
  }

  async getTask(id: string): Promise<SwarmTask> {
    return this.request<SwarmTask>('GET', `/tasks/${encodeURIComponent(id)}`);
  }

  async claimTask(id: string, agent: string): Promise<SwarmTask | null> {
    return this.requestOr409Null<SwarmTask>(
      'POST',
      `/tasks/${encodeURIComponent(id)}/claim`,
      { agent },
    );
  }

  async completeTask(
    id: string,
    agent: string,
    result: string,
    sha?: string,
  ): Promise<SwarmTask> {
    return this.request<SwarmTask>(
      'POST',
      `/tasks/${encodeURIComponent(id)}/complete`,
      { agent, result, sha },
    );
  }

  async failTask(
    id: string,
    agent: string,
    error: string,
  ): Promise<SwarmTask> {
    return this.request<SwarmTask>(
      'POST',
      `/tasks/${encodeURIComponent(id)}/fail`,
      { agent, error },
    );
  }

  // ─── Agents ───

  async registerAgent(
    name: string,
    role?: AgentRole,
  ): Promise<SwarmAgent> {
    return this.request<SwarmAgent>('POST', '/agents/register', { name, role });
  }

  async heartbeat(name: string): Promise<void> {
    await this.request<{ ok: true }>('POST', '/agents/heartbeat', { name });
  }

  async listAgents(): Promise<SwarmAgent[]> {
    return this.request<SwarmAgent[]>('GET', '/agents');
  }

  // ─── Messages ───

  async sendMessage(
    from: string,
    to: string,
    type: MessageType,
    payload: unknown,
  ): Promise<SwarmMessage> {
    return this.request<SwarmMessage>('POST', '/messages', {
      from,
      to,
      type,
      payload,
    });
  }

  async receiveMessages(
    agent: string,
    since?: number,
  ): Promise<{ messages: SwarmMessage[]; nextOffset: number }> {
    const params = new URLSearchParams();
    if (since !== undefined) params.set('since', String(since));
    const qs = params.toString();
    const path = `/messages/${encodeURIComponent(agent)}${qs ? `?${qs}` : ''}`;
    return this.request<{ messages: SwarmMessage[]; nextOffset: number }>(
      'GET',
      path,
    );
  }

  // ─── Locks ───

  async acquireLock(
    resource: string,
    owner: string,
    ttlMs?: number,
  ): Promise<boolean> {
    return this.requestOr409Bool('POST', '/locks', {
      resource,
      owner,
      ttlMs,
    });
  }

  async releaseLock(resource: string, owner: string): Promise<boolean> {
    return this.requestOr409Bool(
      'DELETE',
      `/locks/${encodeURIComponent(resource)}`,
      { owner },
    );
  }

  // ─── Health ───

  async health(): Promise<CoordHealth> {
    return this.request<CoordHealth>('GET', '/health');
  }
}

// ─── Helper: discover or start the coordination server ───

async function waitForPortFile(
  portFile: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf-8').trim();
      if (port) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Coordination server did not write port file within ${timeoutMs}ms`,
  );
}

export async function getOrStartCoordServer(): Promise<CoordClient> {
  const portFile = COORD_PORT_FILE;

  // 1. Check if port file exists and server is alive
  if (existsSync(portFile)) {
    const port = readFileSync(portFile, 'utf-8').trim();
    const client = new CoordClient(`http://localhost:${port}`);
    try {
      await client.health();
      return client; // Server is alive
    } catch {
      // Server is dead, clean up and start new one
      unlinkSync(portFile);
    }
  }

  // 2. Start coordination server as detached background process
  const serverPath = join(
    dirname(fileURLToPath(import.meta.url)),
    'coord-server.js',
  );

  // Ensure the work directory exists and is writable before spawning
  try {
    mkdirSync(WORK_DIR, { recursive: true });
    const testFile = join(WORK_DIR, '.write-test');
    writeFileSync(testFile, 'ok');
    unlinkSync(testFile);
  } catch (err) {
    throw new Error(
      `Coordination directory ${WORK_DIR} is not writable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const proc = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: 'ignore',
  });
  proc.on('error', (err) => {
    console.error('[coord-client] Failed to spawn coordination server:', err.message);
  });
  proc.unref();

  // 3. Wait for port file to appear (poll every 100ms, timeout 10s)
  const port = await waitForPortFile(portFile, 10000);
  const client = new CoordClient(`http://localhost:${port}`);
  await client.health(); // verify
  return client;
}
