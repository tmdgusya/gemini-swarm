import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan, updateTaskStatus } from '../plan-parser.js';

describe('PlanParser', () => {
  const testDir = '/tmp/gemini-swarm-test-plan-parser';

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

  test('updateTaskStatus uses atomic write (no .tmp file remains)', () => {
    const planPath = join(testDir, 'plan.md');
    const planContent = `# Plan: Test Plan
## Phase 1: Setup
- [ ] Task 1.1: Do something
- [ ] Task 1.2: Do another thing
`;
    writeFileSync(planPath, planContent);

    updateTaskStatus(planPath, '1.1', 'completed', 'abc1234');

    // Verify no .tmp files remain
    const files = readdirSync(testDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    assert.strictEqual(tmpFiles.length, 0, 'No .tmp files should remain after atomic write');

    // Verify the plan was actually updated
    const updated = readFileSync(planPath, 'utf-8');
    assert.ok(updated.includes('[x]'), 'Task should be marked completed');
    assert.ok(updated.includes('abc1234'), 'SHA should be included');
  });

  test('updateTaskStatus preserves other tasks', () => {
    const planPath = join(testDir, 'plan.md');
    const planContent = `# Plan: Test Plan
## Phase 1: Setup
- [ ] Task 1.1: First task
- [ ] Task 1.2: Second task
`;
    writeFileSync(planPath, planContent);

    updateTaskStatus(planPath, '1.1', 'in_progress');

    const updated = readFileSync(planPath, 'utf-8');
    assert.ok(updated.includes('[~] Task 1.1'), 'Task 1.1 should be in_progress');
    assert.ok(updated.includes('[ ] Task 1.2'), 'Task 1.2 should remain pending');
  });

  test('parsePlan parses basic plan structure', () => {
    const plan = parsePlan(`# Plan: My Plan
## Phase 1: Init
- [ ] Task 1.1: Setup env
- [x] Task 1.2: Install deps  <!-- sha: deadbeef -->
## Phase 2: Build
- [~] Task 2.1: Build project
`);
    assert.strictEqual(plan.title, 'My Plan');
    assert.strictEqual(plan.phases.length, 2);
    assert.strictEqual(plan.phases[0].tasks.length, 2);
    assert.strictEqual(plan.phases[0].tasks[1].status, 'completed');
    assert.strictEqual(plan.phases[0].tasks[1].sha, 'deadbeef');
    assert.strictEqual(plan.phases[1].tasks[0].status, 'in_progress');
  });
});
