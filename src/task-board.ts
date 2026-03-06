import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskResult, AgentRole } from './types.js';

export interface CreateTaskOptions {
  prompt: string;
  role: AgentRole;
  dependsOn?: string[];
  context?: string;
}

export class TaskBoard {
  private tasksDir: string;

  constructor(workDir: string) {
    this.tasksDir = join(workDir, 'tasks');
    mkdirSync(this.tasksDir, { recursive: true });
  }

  createTask(opts: CreateTaskOptions): Task {
    const id = `task-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      prompt: opts.prompt,
      role: opts.role,
      status: 'pending',
      dependsOn: opts.dependsOn,
      context: opts.context,
      createdAt: now,
      updatedAt: now,
    };
    this.writeTask(task);
    return task;
  }

  getTask(id: string): Task | null {
    try {
      const data = readFileSync(join(this.tasksDir, `${id}.json`), 'utf-8');
      return JSON.parse(data) as Task;
    } catch {
      return null;
    }
  }

  getAllTasks(): Task[] {
    const files = readdirSync(this.tasksDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const data = readFileSync(join(this.tasksDir, f), 'utf-8');
      return JSON.parse(data) as Task;
    });
  }

  getAvailableTasks(): Task[] {
    const allTasks = this.getAllTasks();
    const completedIds = new Set(
      allTasks.filter(t => t.status === 'completed').map(t => t.id)
    );

    return allTasks.filter(t => {
      if (t.status !== 'pending') return false;
      if (t.dependsOn && t.dependsOn.length > 0) {
        return t.dependsOn.every(depId => completedIds.has(depId));
      }
      return true;
    });
  }

  claimTask(id: string, agentName: string): Task | null {
    const task = this.getTask(id);
    if (!task || task.status !== 'pending') return null;

    task.status = 'in_progress';
    task.assignedTo = agentName;
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
    return task;
  }

  completeTask(id: string, result: TaskResult): Task | null {
    const task = this.getTask(id);
    if (!task) return null;

    task.status = result.status === 'completed' ? 'completed' : 'failed';
    task.result = result;
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
    return task;
  }

  private writeTask(task: Task): void {
    writeFileSync(
      join(this.tasksDir, `${task.id}.json`),
      JSON.stringify(task, null, 2)
    );
  }
}
