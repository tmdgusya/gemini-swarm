import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
// We test the coord-server by starting it and making HTTP requests
import { startCoordServer } from '../coord-server.js';

function request(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let data: unknown;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rawRequest(port: number, method: string, path: string, rawBody: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(rawBody),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let data: unknown;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

describe('Coordination Server', () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    server = await startCoordServer();
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test('returns 400 for invalid JSON body on POST /tasks', async () => {
    const res = await rawRequest(port, 'POST', '/tasks', '{invalid json!!!');
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual((res.data as any).error, 'Invalid JSON body');
  });

  test('returns 400 for invalid JSON body on POST /agents/register', async () => {
    const res = await rawRequest(port, 'POST', '/agents/register', 'not json');
    assert.strictEqual(res.status, 400);
  });

  test('returns 400 for invalid JSON body on POST /messages', async () => {
    const res = await rawRequest(port, 'POST', '/messages', '{{{{');
    assert.strictEqual(res.status, 400);
  });

  test('task ID URL encoding/decoding roundtrip', async () => {
    const taskId = 'task with spaces/and&special=chars';
    await request(port, 'POST', '/tasks', {
      tasks: [{ id: taskId, description: 'test', prompt: 'test' }],
    });
    const encodedId = encodeURIComponent(taskId);
    const res = await request(port, 'GET', `/tasks/${encodedId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.data as any).id, taskId);
  });

  test('rejects agent registration with empty name', async () => {
    const res = await request(port, 'POST', '/agents/register', { name: '' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((res.data as any).error, 'Agent name is required');
  });

  test('rejects agent registration with whitespace-only name', async () => {
    const res = await request(port, 'POST', '/agents/register', { name: '   ' });
    assert.strictEqual(res.status, 400);
  });

  test('rejects agent registration with missing name', async () => {
    const res = await request(port, 'POST', '/agents/register', { role: 'coder' });
    assert.strictEqual(res.status, 400);
  });

  test('accepts valid agent registration', async () => {
    const res = await request(port, 'POST', '/agents/register', { name: 'test-agent' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((res.data as any).name, 'test-agent');
  });

  test('message queue evicts oldest when exceeding limit', async () => {
    // Register an agent first
    await request(port, 'POST', '/agents/register', { name: 'receiver' });

    // Send 1002 messages (limit is 1000)
    for (let i = 0; i < 1002; i++) {
      await request(port, 'POST', '/messages', {
        from: 'sender',
        to: 'receiver',
        type: 'info',
        payload: { index: i },
      });
    }

    // Fetch all messages
    const res = await request(port, 'GET', '/messages/receiver');
    assert.strictEqual(res.status, 200);
    const messages = (res.data as any).messages;
    assert.ok(messages.length <= 1000, `Queue should be capped at 1000, got ${messages.length}`);
  });

  test('CORS preflight returns 204 with empty body', async () => {
    const res = await new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/tasks',
        method: 'OPTIONS',
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.body, '', 'Preflight should have empty body');
    assert.ok(res.headers['access-control-allow-methods'], 'Should have CORS headers');
  });
});
