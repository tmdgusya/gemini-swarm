import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageBus } from '../message-bus.js';

describe('MessageBus', () => {
  function createBus(): MessageBus {
    const dir = mkdtempSync(join(tmpdir(), 'msgbus-'));
    return new MessageBus(dir);
  }

  it('sends and receives messages', () => {
    const bus = createBus();

    bus.send({ from: 'alice', to: 'bob', type: 'info', payload: { text: 'hello' } });

    const msgs = bus.receive('bob');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].from, 'alice');
    assert.strictEqual(msgs[0].to, 'bob');
    assert.strictEqual(msgs[0].type, 'info');
    assert.deepStrictEqual(msgs[0].payload, { text: 'hello' });
    assert.ok(msgs[0].id.startsWith('msg-'));
    assert.ok(msgs[0].timestamp);
  });

  it('receive returns only new (unread) messages', () => {
    const bus = createBus();

    bus.send({ from: 'alice', to: 'bob', type: 'info', payload: 'first' });
    const first = bus.receive('bob');
    assert.strictEqual(first.length, 1);

    // Second receive with no new messages
    const empty = bus.receive('bob');
    assert.strictEqual(empty.length, 0);

    // Send another message, only the new one should appear
    bus.send({ from: 'alice', to: 'bob', type: 'task', payload: 'second' });
    const second = bus.receive('bob');
    assert.strictEqual(second.length, 1);
    assert.deepStrictEqual(second[0].payload, 'second');
  });

  it('broadcast sends to all agents', () => {
    const bus = createBus();

    const agents = ['agent-1', 'agent-2', 'agent-3'];
    const sent = bus.broadcast('orchestrator', agents, 'task', { action: 'start' });

    assert.strictEqual(sent.length, 3);

    for (const agent of agents) {
      const msgs = bus.receive(agent);
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].from, 'orchestrator');
      assert.strictEqual(msgs[0].to, agent);
      assert.deepStrictEqual(msgs[0].payload, { action: 'start' });
    }
  });

  it('receive returns empty array for agent with no inbox', () => {
    const bus = createBus();
    const msgs = bus.receive('nonexistent');
    assert.strictEqual(msgs.length, 0);
  });
});
