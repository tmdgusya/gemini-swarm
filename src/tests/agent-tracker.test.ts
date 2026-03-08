import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentTracker } from '../agent-tracker.js';

describe('AgentTracker', () => {
  const testDir = '/tmp/gemini-swarm-test-tracker';

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

  test('getResults skips corrupt JSON result files', () => {
    const tracker = new AgentTracker(testDir);
    const resultsDir = join(testDir, 'results');

    // Write a valid result file
    writeFileSync(join(resultsDir, 'task-good.json'), JSON.stringify({
      taskId: 'task-good',
      agent: 'agent-1',
      response: 'done',
      duration: 100,
      completedAt: new Date().toISOString(),
    }));

    // Write a corrupt result file
    writeFileSync(join(resultsDir, 'task-bad.json'), '{corrupt!!!');

    // Write another valid result file
    writeFileSync(join(resultsDir, 'task-ok.json'), JSON.stringify({
      taskId: 'task-ok',
      agent: 'agent-2',
      response: 'also done',
      duration: 200,
      completedAt: new Date().toISOString(),
    }));

    const results = tracker.getResults();
    assert.strictEqual(results.length, 2, 'Should return 2 valid results, skipping corrupt one');
    const taskIds = results.map(r => r.taskId).sort();
    assert.deepStrictEqual(taskIds, ['task-good', 'task-ok']);
  });

  test('updateStatus protects immutable fields (name, startedAt)', () => {
    const tracker = new AgentTracker(testDir);
    const agent = tracker.register({
      name: 'my-agent',
      role: 'coder',
      prompt: 'do stuff',
    });

    const originalName = agent.name;
    const originalStartedAt = agent.startedAt;

    // Try to overwrite name and startedAt via extra
    tracker.updateStatus('my-agent', 'running', {
      name: 'hacked-name',
      startedAt: '1970-01-01T00:00:00.000Z',
      response: 'some response',
    } as any);

    const updated = tracker.getAgent('my-agent');
    assert.ok(updated);
    assert.strictEqual(updated.name, originalName, 'name should not be overwritten');
    assert.strictEqual(updated.startedAt, originalStartedAt, 'startedAt should not be overwritten');
    assert.strictEqual(updated.response, 'some response', 'response should be set');
    assert.strictEqual(updated.status, 'running');
  });

  test('updateStatus sets allowed extra fields', () => {
    const tracker = new AgentTracker(testDir);
    tracker.register({ name: 'agent-a', role: 'generalist', prompt: 'test' });

    tracker.updateStatus('agent-a', 'running', {
      pid: 12345,
      paneId: 'pane-1',
    });

    const agent = tracker.getAgent('agent-a');
    assert.ok(agent);
    assert.strictEqual(agent.pid, 12345);
    assert.strictEqual(agent.paneId, 'pane-1');
  });

  test('getResults returns empty array when results dir does not exist', () => {
    // Remove the results dir that constructor created
    rmSync(join(testDir, 'results'), { recursive: true, force: true });
    const tracker2 = new AgentTracker(testDir);
    // Remove it again after constructor recreated it
    rmSync(join(testDir, 'results'), { recursive: true, force: true });
    const results = tracker2.getResults();
    assert.deepStrictEqual(results, []);
  });
});
