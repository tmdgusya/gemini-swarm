import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TaskBoard, type CreateTaskOptions } from './task-board.js';
import { MessageBus } from './message-bus.js';
import { AgentRunner, type RunResult } from './agent-runner.js';
import { WorktreeManager } from './worktree-manager.js';
import type { SwarmConfig, Task, AgentRole } from './types.js';

const ROLE_PREFIXES: Record<AgentRole, string> = {
  researcher:
    'You are a research agent. Focus on gathering information, reading code, and analyzing patterns. Do NOT modify files.',
  coder:
    'You are a coding agent. Implement the requested changes precisely. Write clean, tested code.',
  reviewer:
    'You are a code review agent. Review code for bugs, security issues, and improvements. Do NOT modify files.',
  generalist:
    'You are a general-purpose agent. Complete the assigned task efficiently.',
};

export class SwarmOrchestrator {
  private config: SwarmConfig;
  private taskBoard: TaskBoard;
  private messageBus: MessageBus;
  private runner: AgentRunner;
  private worktreeManager: WorktreeManager | null;
  private swarmDir: string;
  private resultsDir: string;

  constructor(config: SwarmConfig) {
    this.config = config;
    this.swarmDir = join(config.workDir, 'swarm');
    this.resultsDir = join(this.swarmDir, 'results');

    mkdirSync(this.swarmDir, { recursive: true });
    mkdirSync(this.resultsDir, { recursive: true });

    this.taskBoard = new TaskBoard(this.swarmDir);
    this.messageBus = new MessageBus(this.swarmDir);
    this.runner = new AgentRunner({
      model: config.model,
      timeout: config.timeout ?? 300_000,
      extraFlags: config.geminiFlags,
    });
    this.worktreeManager = config.useWorktrees
      ? new WorktreeManager(config.workDir)
      : null;
  }

  addTasks(tasks: CreateTaskOptions[]): Task[] {
    return tasks.map((t) => this.taskBoard.createTask(t));
  }

  async run(): Promise<Map<string, RunResult>> {
    const allResults = new Map<string, RunResult>();
    const running = new Map<string, { taskId: string; promise: Promise<{ agentName: string; taskId: string; result: RunResult }> }>();
    let agentCounter = 0;

    const hasPendingOrRunning = (): boolean => {
      const tasks = this.taskBoard.getAllTasks();
      return tasks.some(
        (t) => t.status === 'pending' || t.status === 'in_progress'
      );
    };

    while (hasPendingOrRunning()) {
      const available = this.taskBoard.getAvailableTasks();
      const slotsOpen = this.config.maxAgents - running.size;

      for (let i = 0; i < Math.min(available.length, slotsOpen); i++) {
        const task = available[i];
        agentCounter++;
        const agentName = `agent-${agentCounter}`;

        const claimed = this.taskBoard.claimTask(task.id, agentName);
        if (!claimed) continue;

        console.log(
          `[swarm] Dispatching ${agentName} (${claimed.role}) for task ${claimed.id}`
        );

        const promise = this.dispatchAgent(agentName, claimed).then(
          (result) => ({ agentName, taskId: claimed.id, result })
        );

        running.set(agentName, { taskId: claimed.id, promise });
      }

      if (running.size === 0) {
        // No running agents and nothing available — could be a deadlock or all done
        break;
      }

      // Wait for at least one agent to complete
      const completions = Array.from(running.values()).map((r) => r.promise);
      const completed = await Promise.race(completions);

      // Process the completed agent
      const { agentName, taskId, result } = completed;
      running.delete(agentName);

      // Save result
      writeFileSync(
        join(this.resultsDir, `${taskId}.json`),
        JSON.stringify(result, null, 2)
      );

      // Update task board
      this.taskBoard.completeTask(taskId, {
        taskId,
        agent: agentName,
        status: result.status,
        response: result.response,
        stats: result.stats,
        error: result.error,
        durationMs: result.durationMs,
      });

      console.log(
        `[swarm] ${agentName} finished task ${taskId} — ${result.status} (${result.durationMs}ms)`
      );

      allResults.set(taskId, result);

      // Cleanup worktree
      if (this.worktreeManager) {
        this.worktreeManager.remove(agentName);
      }
    }

    // Wait for any remaining running agents
    for (const [agentName, { taskId, promise }] of running) {
      const { result } = await promise;

      writeFileSync(
        join(this.resultsDir, `${taskId}.json`),
        JSON.stringify(result, null, 2)
      );

      this.taskBoard.completeTask(taskId, {
        taskId,
        agent: agentName,
        status: result.status,
        response: result.response,
        stats: result.stats,
        error: result.error,
        durationMs: result.durationMs,
      });

      console.log(
        `[swarm] ${agentName} finished task ${taskId} — ${result.status} (${result.durationMs}ms)`
      );

      allResults.set(taskId, result);

      if (this.worktreeManager) {
        this.worktreeManager.remove(agentName);
      }
    }

    console.log(`[swarm] All tasks completed. Total: ${allResults.size}`);
    return allResults;
  }

  private async dispatchAgent(
    agentName: string,
    task: Task
  ): Promise<RunResult> {
    let cwd = this.config.workDir;

    // If worktrees enabled and role is coder, create a worktree
    if (this.worktreeManager && task.role === 'coder') {
      const worktree = this.worktreeManager.create(agentName);
      cwd = worktree.path;
    }

    // Gather dependency results as context
    let dependencyContext = '';
    if (task.dependsOn && task.dependsOn.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.dependsOn) {
        try {
          const data = readFileSync(
            join(this.resultsDir, `${depId}.json`),
            'utf-8'
          );
          const depResult = JSON.parse(data) as RunResult;
          depResults.push(
            `--- Result from dependency ${depId} ---\n${depResult.response}\n--- End ${depId} ---`
          );
        } catch {
          // Dependency result not available, skip
        }
      }
      if (depResults.length > 0) {
        dependencyContext = depResults.join('\n\n') + '\n\n';
      }
    }

    // Build the prompt with role prefix
    const rolePrefix = ROLE_PREFIXES[task.role];
    const fullPrompt = `${rolePrefix}\n\n${task.prompt}`;

    // Build context string
    const context =
      (dependencyContext || '') + (task.context ? task.context + '\n' : '');

    return this.runner.run({
      prompt: fullPrompt,
      cwd,
      context: context || undefined,
    });
  }

  async aggregate(prompt: string): Promise<RunResult> {
    const tasks = this.taskBoard.getAllTasks();
    const completedResults: string[] = [];

    for (const task of tasks) {
      if (task.status !== 'completed') continue;
      try {
        const data = readFileSync(
          join(this.resultsDir, `${task.id}.json`),
          'utf-8'
        );
        const result = JSON.parse(data) as RunResult;
        completedResults.push(
          `--- Task ${task.id} (${task.role}): ${task.prompt.slice(0, 100)} ---\n${result.response}\n--- End ${task.id} ---`
        );
      } catch {
        // Skip missing results
      }
    }

    const context = completedResults.join('\n\n');

    console.log(
      `[swarm] Aggregating ${completedResults.length} task results`
    );

    return this.runner.run({
      prompt,
      cwd: this.config.workDir,
      context: context || undefined,
    });
  }

  cleanup(): void {
    if (this.worktreeManager) {
      this.worktreeManager.cleanupAll();
      console.log('[swarm] Worktrees cleaned up');
    }
  }
}
