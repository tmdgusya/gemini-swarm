import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { InboxWatcher } from '../inbox-watcher.js';

describe('InboxWatcher', () => {
  const testDir = '/tmp/gemini-swarm-test-inbox-watcher';

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

  test('debounces rapid consecutive events into a single emit', async () => {
    const watcher = new InboxWatcher(testDir, 50);
    const emitted: string[] = [];

    watcher.on('message', (agentName: string) => {
      emitted.push(agentName);
    });

    watcher.start();

    // Create a .jsonl file
    const file = join(testDir, 'agent-1.jsonl');
    writeFileSync(file, '');

    // Rapidly write multiple times
    for (let i = 0; i < 5; i++) {
      appendFileSync(file, `{"msg":${i}}\n`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    // Wait for debounce to settle
    await new Promise(resolve => setTimeout(resolve, 150));

    watcher.stop();

    // Should have at most 1-2 emissions due to debounce, not 5
    assert.ok(emitted.length <= 2, `Expected at most 2 emissions due to debounce, got ${emitted.length}`);
    assert.ok(emitted.length >= 1, 'Expected at least 1 emission');
    assert.strictEqual(emitted[0], 'agent-1');
  });

  test('stop() clears all pending timers', async () => {
    const watcher = new InboxWatcher(testDir, 200); // long debounce
    const emitted: string[] = [];

    watcher.on('message', (agentName: string) => {
      emitted.push(agentName);
    });

    watcher.start();

    // Write to trigger a debounced event
    const file = join(testDir, 'agent-2.jsonl');
    writeFileSync(file, '{"test":true}\n');

    // Stop immediately before debounce fires
    await new Promise(resolve => setTimeout(resolve, 20));
    watcher.stop();

    // Wait for what would have been the debounce period
    await new Promise(resolve => setTimeout(resolve, 250));

    assert.strictEqual(emitted.length, 0, 'No events should fire after stop()');
  });

  test('ignores non-.jsonl files', async () => {
    const watcher = new InboxWatcher(testDir, 20);
    const emitted: string[] = [];

    watcher.on('message', (agentName: string) => {
      emitted.push(agentName);
    });

    watcher.start();

    // Write a non-.jsonl file
    writeFileSync(join(testDir, 'notes.txt'), 'hello');

    await new Promise(resolve => setTimeout(resolve, 100));
    watcher.stop();

    assert.strictEqual(emitted.length, 0, 'Should not emit for non-.jsonl files');
  });

  test('creates inbox directory if it does not exist', () => {
    const newDir = join(testDir, 'nested', 'inbox');
    const watcher = new InboxWatcher(newDir);
    assert.ok(existsSync(newDir), 'Inbox directory should be created');
    watcher.stop();
  });
});
