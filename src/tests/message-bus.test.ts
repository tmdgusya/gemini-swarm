import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { MessageBus } from '../message-bus.js';

describe('MessageBus', () => {
  const testDir = '/tmp/gemini-swarm-test-msgbus';

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('skips corrupt JSONL lines and returns valid messages', () => {
    const bus = new MessageBus(testDir);

    // Manually write inbox with a mix of valid and invalid lines
    const inboxDir = join(testDir, 'inbox');
    const inboxFile = join(inboxDir, 'agent-1.jsonl');

    const validMsg1 = JSON.stringify({
      id: 'msg-1', from: 'sender', to: 'agent-1',
      type: 'info', payload: { data: 'first' }, timestamp: new Date().toISOString(),
    });
    const invalidLine = '{broken json!!!';
    const validMsg2 = JSON.stringify({
      id: 'msg-2', from: 'sender', to: 'agent-1',
      type: 'info', payload: { data: 'second' }, timestamp: new Date().toISOString(),
    });

    appendFileSync(inboxFile, validMsg1 + '\n');
    appendFileSync(inboxFile, invalidLine + '\n');
    appendFileSync(inboxFile, validMsg2 + '\n');

    const messages = bus.receive('agent-1');
    assert.strictEqual(messages.length, 2, 'Should receive 2 valid messages, skipping the corrupt one');
    assert.strictEqual(messages[0].id, 'msg-1');
    assert.strictEqual(messages[1].id, 'msg-2');
  });

  test('offset is correctly managed after partial parse failure', () => {
    const bus = new MessageBus(testDir);

    const inboxDir = join(testDir, 'inbox');
    const inboxFile = join(inboxDir, 'agent-2.jsonl');

    // Write 3 lines: valid, invalid, valid
    appendFileSync(inboxFile, JSON.stringify({
      id: 'msg-a', from: 's', to: 'agent-2', type: 'info', payload: {}, timestamp: new Date().toISOString(),
    }) + '\n');
    appendFileSync(inboxFile, 'NOT JSON\n');
    appendFileSync(inboxFile, JSON.stringify({
      id: 'msg-b', from: 's', to: 'agent-2', type: 'info', payload: {}, timestamp: new Date().toISOString(),
    }) + '\n');

    // First receive
    const msgs1 = bus.receive('agent-2');
    assert.strictEqual(msgs1.length, 2);

    // Second receive should return nothing (offset advanced past all 3 lines)
    const msgs2 = bus.receive('agent-2');
    assert.strictEqual(msgs2.length, 0, 'Should return no new messages');

    // Now add a new message
    appendFileSync(inboxFile, JSON.stringify({
      id: 'msg-c', from: 's', to: 'agent-2', type: 'info', payload: {}, timestamp: new Date().toISOString(),
    }) + '\n');

    const msgs3 = bus.receive('agent-2');
    assert.strictEqual(msgs3.length, 1, 'Should return only the new message');
    assert.strictEqual(msgs3[0].id, 'msg-c');
  });

  test('broadcast sends to all agents', () => {
    const bus = new MessageBus(testDir);
    const agents = ['agent-x', 'agent-y', 'agent-z'];

    const sent = bus.broadcast('orchestrator', agents, 'info', { hello: true });
    assert.strictEqual(sent.length, 3);

    for (const agent of agents) {
      const msgs = bus.receive(agent);
      assert.strictEqual(msgs.length, 1, `${agent} should have 1 message`);
      assert.strictEqual(msgs[0].from, 'orchestrator');
    }
  });

  test('send and receive basic messages', () => {
    const bus = new MessageBus(testDir);

    bus.send({ from: 'a', to: 'b', type: 'info', payload: 'hello' });
    bus.send({ from: 'a', to: 'b', type: 'info', payload: 'world' });

    const msgs = bus.receive('b');
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].payload, 'hello');
    assert.strictEqual(msgs[1].payload, 'world');
  });
});
