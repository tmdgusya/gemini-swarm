import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskBoard } from '../task-board.js';
import type { TaskResult } from '../types.js';

describe('TaskBoard', () => {
  let workDir: string;
  let board: TaskBoard;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'taskboard-test-'));
    board = new TaskBoard(workDir);
  });

  describe('createTask / getTask', () => {
    it('creates a task and retrieves it by id', () => {
      const task = board.createTask({
        prompt: 'Do something',
        role: 'coder',
      });

      assert.ok(task.id.startsWith('task-'));
      assert.strictEqual(task.prompt, 'Do something');
      assert.strictEqual(task.role, 'coder');
      assert.strictEqual(task.status, 'pending');
      assert.ok(task.createdAt);

      const retrieved = board.getTask(task.id);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.id, task.id);
      assert.strictEqual(retrieved.prompt, task.prompt);
      assert.strictEqual(retrieved.role, task.role);
      assert.strictEqual(retrieved.status, task.status);
      assert.strictEqual(retrieved.createdAt, task.createdAt);
      assert.strictEqual(retrieved.updatedAt, task.updatedAt);
    });

    it('returns null for nonexistent task', () => {
      assert.strictEqual(board.getTask('task-nonexistent'), null);
    });

    it('stores optional fields (dependsOn, context)', () => {
      const task = board.createTask({
        prompt: 'Review code',
        role: 'reviewer',
        dependsOn: ['task-abc'],
        context: 'some context',
      });

      const retrieved = board.getTask(task.id);
      assert.ok(retrieved);
      assert.deepStrictEqual(retrieved.dependsOn, ['task-abc']);
      assert.strictEqual(retrieved.context, 'some context');
    });
  });

  describe('getAllTasks', () => {
    it('returns all created tasks', () => {
      board.createTask({ prompt: 'A', role: 'coder' });
      board.createTask({ prompt: 'B', role: 'researcher' });
      board.createTask({ prompt: 'C', role: 'generalist' });

      const all = board.getAllTasks();
      assert.strictEqual(all.length, 3);
    });
  });

  describe('claimTask', () => {
    it('claims a pending task', () => {
      const task = board.createTask({ prompt: 'Work', role: 'coder' });
      const claimed = board.claimTask(task.id, 'agent-1');

      assert.ok(claimed);
      assert.strictEqual(claimed.status, 'in_progress');
      assert.strictEqual(claimed.assignedTo, 'agent-1');

      // Verify persisted
      const fromDisk = board.getTask(task.id);
      assert.strictEqual(fromDisk!.status, 'in_progress');
      assert.strictEqual(fromDisk!.assignedTo, 'agent-1');
    });

    it('prevents double-claim', () => {
      const task = board.createTask({ prompt: 'Work', role: 'coder' });
      const first = board.claimTask(task.id, 'agent-1');
      assert.ok(first);

      const second = board.claimTask(task.id, 'agent-2');
      assert.strictEqual(second, null);
    });

    it('returns null for nonexistent task', () => {
      assert.strictEqual(board.claimTask('task-nope', 'agent-1'), null);
    });
  });

  describe('completeTask', () => {
    it('completes a task with success result', () => {
      const task = board.createTask({ prompt: 'Work', role: 'coder' });
      board.claimTask(task.id, 'agent-1');

      const result: TaskResult = {
        taskId: task.id,
        agent: 'agent-1',
        status: 'completed',
        response: 'Done!',
        durationMs: 1000,
      };

      const completed = board.completeTask(task.id, result);
      assert.ok(completed);
      assert.strictEqual(completed.status, 'completed');
      assert.deepStrictEqual(completed.result, result);
    });

    it('marks a task as failed when result status is failed', () => {
      const task = board.createTask({ prompt: 'Work', role: 'coder' });
      board.claimTask(task.id, 'agent-1');

      const result: TaskResult = {
        taskId: task.id,
        agent: 'agent-1',
        status: 'failed',
        response: '',
        error: 'Something went wrong',
        durationMs: 500,
      };

      const failed = board.completeTask(task.id, result);
      assert.ok(failed);
      assert.strictEqual(failed.status, 'failed');
    });
  });

  describe('getAvailableTasks', () => {
    it('returns pending tasks with no dependencies', () => {
      board.createTask({ prompt: 'A', role: 'coder' });
      board.createTask({ prompt: 'B', role: 'coder' });

      const available = board.getAvailableTasks();
      assert.strictEqual(available.length, 2);
    });

    it('excludes tasks with unmet dependencies', () => {
      const t1 = board.createTask({ prompt: 'First', role: 'coder' });
      board.createTask({
        prompt: 'Second',
        role: 'coder',
        dependsOn: [t1.id],
      });

      const available = board.getAvailableTasks();
      assert.strictEqual(available.length, 1);
      assert.strictEqual(available[0].prompt, 'First');
    });

    it('includes tasks whose dependencies are all completed', () => {
      const t1 = board.createTask({ prompt: 'First', role: 'coder' });
      const t2 = board.createTask({
        prompt: 'Second',
        role: 'coder',
        dependsOn: [t1.id],
      });

      // Complete t1
      board.claimTask(t1.id, 'agent-1');
      board.completeTask(t1.id, {
        taskId: t1.id,
        agent: 'agent-1',
        status: 'completed',
        response: 'done',
        durationMs: 100,
      });

      const available = board.getAvailableTasks();
      assert.strictEqual(available.length, 1);
      assert.strictEqual(available[0].id, t2.id);
    });

    it('excludes in_progress and completed tasks', () => {
      const t1 = board.createTask({ prompt: 'A', role: 'coder' });
      board.createTask({ prompt: 'B', role: 'coder' });

      board.claimTask(t1.id, 'agent-1');

      const available = board.getAvailableTasks();
      assert.strictEqual(available.length, 1);
      assert.strictEqual(available[0].prompt, 'B');
    });
  });
});
