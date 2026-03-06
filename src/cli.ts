#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from './swarm-config.js';
import type { SwarmConfig, AgentRole } from './types.js';
import type { CreateTaskOptions } from './task-board.js';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  help: boolean;
  fanOut: boolean;
  prompt?: string;
  n: number;
  configPath?: string;
  maxAgents?: number;
  model?: string;
  worktrees: boolean;
  aggregate?: string;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node + script
  const parsed: ParsedArgs = {
    help: false,
    fanOut: false,
    n: 1,
    worktrees: false,
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--fan-out':
        parsed.fanOut = true;
        break;
      case '--prompt':
        parsed.prompt = args[++i];
        break;
      case '-n':
        parsed.n = parseInt(args[++i], 10);
        if (isNaN(parsed.n) || parsed.n < 1) {
          console.error('Error: -n must be a positive integer');
          process.exit(1);
        }
        break;
      case '--config':
        parsed.configPath = args[++i];
        break;
      case '--max-agents':
        parsed.maxAgents = parseInt(args[++i], 10);
        if (isNaN(parsed.maxAgents) || parsed.maxAgents < 1) {
          console.error('Error: --max-agents must be a positive integer');
          process.exit(1);
        }
        break;
      case '--model':
        parsed.model = args[++i];
        break;
      case '--worktrees':
        parsed.worktrees = true;
        break;
      case '--aggregate':
        parsed.aggregate = args[++i];
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Error: unknown option "${arg}"`);
          process.exit(1);
        }
        parsed.positional.push(arg);
        break;
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  const usage = `
gemini-swarm — orchestrate parallel Gemini CLI agents

Usage:
  npx tsx src/cli.ts <tasks.json>              Load tasks from JSON file
  npx tsx src/cli.ts --fan-out <prompts.json>  Fan-out: one researcher task per prompt
  npx tsx src/cli.ts --prompt "question" -n 3  Create N generalist tasks with same prompt

Options:
  --config <path>       Path to swarm.json config file
  --max-agents <n>      Override maxAgents from config
  --model <model>       Override Gemini model
  --worktrees           Enable git worktree isolation
  --aggregate "prompt"  After all tasks complete, aggregate results with this prompt
  --help, -h            Show this help message
`.trim();

  console.log(usage);
}

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

function loadTasksFromFile(filePath: string): CreateTaskOptions[] {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`Error: tasks file not found: ${absPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(absPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    console.error('Error: tasks file must contain a JSON array');
    process.exit(1);
  }
  return raw.map((entry: Record<string, unknown>) => ({
    prompt: String(entry.prompt ?? ''),
    role: (entry.role as AgentRole) ?? 'generalist',
    dependsOn: entry.dependsOn as string[] | undefined,
    context: entry.context as string | undefined,
  }));
}

function loadFanOutPrompts(filePath: string): CreateTaskOptions[] {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    console.error(`Error: prompts file not found: ${absPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(absPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    console.error('Error: prompts file must contain a JSON array of strings');
    process.exit(1);
  }
  return raw.map((prompt: string) => ({
    prompt: String(prompt),
    role: 'researcher' as AgentRole,
  }));
}

function buildRepeatedTasks(prompt: string, n: number): CreateTaskOptions[] {
  const tasks: CreateTaskOptions[] = [];
  for (let i = 0; i < n; i++) {
    tasks.push({ prompt, role: 'generalist' as AgentRole });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  // ---- Load config with CLI overrides ----
  const config: SwarmConfig = loadConfig(
    parsed.configPath ? resolve(parsed.configPath) : undefined,
  );

  if (parsed.maxAgents !== undefined) config.maxAgents = parsed.maxAgents;
  if (parsed.model !== undefined) config.model = parsed.model;
  if (parsed.worktrees) config.useWorktrees = true;

  // ---- Determine tasks ----
  let taskOptions: CreateTaskOptions[];

  if (parsed.prompt) {
    // --prompt mode
    taskOptions = buildRepeatedTasks(parsed.prompt, parsed.n);
  } else if (parsed.fanOut) {
    // --fan-out mode
    if (parsed.positional.length === 0) {
      console.error('Error: --fan-out requires a prompts JSON file argument');
      process.exit(1);
    }
    taskOptions = loadFanOutPrompts(parsed.positional[0]);
  } else if (parsed.positional.length > 0) {
    // tasks.json mode
    taskOptions = loadTasksFromFile(parsed.positional[0]);
  } else {
    console.error('Error: no tasks specified. Use --help for usage information.');
    process.exit(1);
  }

  if (taskOptions.length === 0) {
    console.error('Error: no tasks to run');
    process.exit(1);
  }

  console.log(`[swarm] Loaded ${taskOptions.length} task(s), maxAgents=${config.maxAgents}`);

  // ---- Create orchestrator ----
  const { SwarmOrchestrator } = await import('./orchestrator.js');
  const orchestrator = new SwarmOrchestrator(config);

  // ---- Add tasks ----
  orchestrator.addTasks(taskOptions);

  // ---- Run ----
  console.log('[swarm] Starting swarm...');
  const results = await orchestrator.run();

  // ---- Print results ----
  console.log(`\n[swarm] Completed. ${results.size} result(s):\n`);
  for (const [taskId, result] of results) {
    const statusIcon = result.status === 'completed' ? 'OK' : 'FAIL';
    console.log(`  [${statusIcon}] ${taskId} (${result.durationMs}ms)`);
    if (result.error) {
      console.log(`        Error: ${result.error}`);
    } else {
      const preview = result.response.slice(0, 200).replace(/\n/g, ' ');
      console.log(`        ${preview}${result.response.length > 200 ? '...' : ''}`);
    }
  }

  // ---- Aggregate ----
  if (parsed.aggregate) {
    console.log('\n[swarm] Running aggregation...');
    const aggregated = await orchestrator.aggregate(parsed.aggregate);
    console.log('\n[swarm] Aggregated result:\n');
    console.log(aggregated.response);
  }

  // ---- Cleanup ----
  orchestrator.cleanup();
  console.log('\n[swarm] Done.');
}

main().catch((err) => {
  console.error('[swarm] Fatal error:', err);
  process.exit(1);
});
