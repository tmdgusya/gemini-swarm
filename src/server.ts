import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TmuxSpawner } from './tmux-spawner.js';
import { CoordClient, getOrStartCoordServer } from './coord-client.js';
import { existsSync, readFileSync } from 'node:fs';
import {
  parsePlan,
  updateTaskStatus,
  findNextPendingPhase,
  getPendingTasks,
  type PlanTask,
  type PlanPhase,
} from './plan-parser.js';
import type { SwarmTask, AgentRole } from './types.js';

// ─── Shared state ───

const spawner = new TmuxSpawner();
let coordClient: CoordClient | null = null;
let messageOffset = 0;

async function getClient(): Promise<CoordClient> {
  if (!coordClient) {
    coordClient = await getOrStartCoordServer();
  }
  return coordClient;
}

function getAgentName(): string {
  return process.env['SWARM_AGENT_NAME'] ?? 'orchestrator';
}

// ─── MCP Server ───

const server = new Server(
  { name: 'gemini-swarm', version: '0.3.0' },
  { capabilities: { tools: {} } },
);

// --- List Tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Orchestrator tools ──
    {
      name: 'swarm_init',
      description:
        'Start the coordination server if not already running. Returns server URL. Only call when you are the orchestrator (no SWARM_AGENT_NAME env var).',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'swarm_create_tasks',
      description:
        'Create tasks on the TaskBoard. Only call when you are the orchestrator (no SWARM_AGENT_NAME env var).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Unique task ID' },
                description: { type: 'string', description: 'Human-readable task description' },
                phase: { type: 'number', description: 'Phase number (optional)' },
                prompt: { type: 'string', description: 'Full prompt for the agent' },
              },
              required: ['id', 'description', 'prompt'],
            },
            description: 'Array of tasks to create',
          },
        },
        required: ['tasks'],
      },
    },
    {
      name: 'swarm_spawn',
      description:
        'Spawn N Gemini CLI agent processes. Agents claim tasks themselves from the TaskBoard. Only call when you are the orchestrator (no SWARM_AGENT_NAME env var).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          count: { type: 'number', description: 'Number of agents to spawn (1-10)' },
          role: {
            type: 'string',
            enum: ['researcher', 'coder', 'reviewer', 'generalist'],
            description: 'Agent role (default: generalist)',
          },
        },
        required: ['count'],
      },
    },
    {
      name: 'swarm_status',
      description:
        'Get status of all agents and tasks. Can be used by both orchestrator and agents.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'swarm_results',
      description:
        'Get completed task results. Only call when you are the orchestrator (no SWARM_AGENT_NAME env var).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Specific task ID to get results for (optional)' },
        },
      },
    },
    {
      name: 'swarm_kill',
      description:
        'Kill agent processes. Only call when you are the orchestrator (no SWARM_AGENT_NAME env var).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent: { type: 'string', description: 'Agent name to kill (omit for all)' },
        },
      },
    },
    // ── Agent tools ──
    {
      name: 'swarm_task_list',
      description:
        'List available (open) tasks on the TaskBoard. Use when you are a swarm agent with an assigned identity.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'swarm_task_claim',
      description:
        'Claim a task atomically from the TaskBoard. Use when you are a swarm agent with an assigned identity.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'ID of the task to claim' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'swarm_task_complete',
      description:
        'Report task completion. Use when you are a swarm agent with an assigned identity.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'ID of the completed task' },
          result: { type: 'string', description: 'Result summary' },
          sha: { type: 'string', description: 'Git SHA of the commit (optional)' },
        },
        required: ['task_id', 'result'],
      },
    },
    {
      name: 'swarm_task_fail',
      description:
        'Report task failure. Use when you are a swarm agent with an assigned identity.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'ID of the failed task' },
          error: { type: 'string', description: 'Error description' },
        },
        required: ['task_id', 'error'],
      },
    },
    // ── Shared tools ──
    {
      name: 'swarm_send',
      description:
        'Send a message to another agent. Can be used by both orchestrator and agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          to: { type: 'string', description: 'Agent name to send to' },
          message: { type: 'string', description: 'Message content' },
        },
        required: ['to', 'message'],
      },
    },
    {
      name: 'swarm_receive',
      description:
        'Check inbox for messages. Can be used by both orchestrator and agents.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'swarm_lock',
      description:
        'Acquire a lock on a resource to prevent concurrent access. Can be used by both orchestrator and agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          resource: { type: 'string', description: 'Resource path to lock' },
          ttlMs: { type: 'number', description: 'Time To Live in milliseconds (optional)' },
        },
        required: ['resource'],
      },
    },
    {
      name: 'swarm_unlock',
      description:
        'Release a lock on a resource. Can be used by both orchestrator and agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          resource: { type: 'string', description: 'Resource path to unlock' },
        },
        required: ['resource'],
      },
    },
    {
      name: 'swarm_heartbeat',
      description:
        'Send a heartbeat to the coordination server. Use when you are a swarm agent with an assigned identity.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // ── Plan execution ──
    {
      name: 'swarm_plan_execute',
      description:
        'Execute a structured plan phase-by-phase. Creates tasks on the TaskBoard, spawns agents, polls for completion, and updates plan.md. Only call when you are the orchestrator (no SWARM_AGENT_NAME env var).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          planDir: {
            type: 'string',
            description: 'Path to the plan directory containing plan.md and spec.md',
          },
          resumePhase: {
            type: 'number',
            description: 'Phase number to resume from (1-indexed). If omitted, starts from the first pending phase.',
          },
          retryTasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs to retry (e.g. ["1.2"]). Only dispatches these tasks.',
          },
          skipTasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs to skip (marks as completed with "skipped" note).',
          },
        },
        required: ['planDir'],
      },
    },
  ],
}));

// --- Call Tool ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'swarm_init':
        return await handleInit();
      case 'swarm_create_tasks':
        return await handleCreateTasks(args as { tasks: Array<{ id: string; description: string; phase?: number; prompt: string }> });
      case 'swarm_spawn':
        return await handleSpawn(args as { count: number; role?: string });
      case 'swarm_status':
        return await handleStatus();
      case 'swarm_results':
        return await handleResults(args as { task_id?: string });
      case 'swarm_kill':
        return await handleKill(args as { agent?: string });
      case 'swarm_task_list':
        return await handleTaskList();
      case 'swarm_task_claim':
        return await handleTaskClaim(args as { task_id: string });
      case 'swarm_task_complete':
        return await handleTaskComplete(args as { task_id: string; result: string; sha?: string });
      case 'swarm_task_fail':
        return await handleTaskFail(args as { task_id: string; error: string });
      case 'swarm_send':
        return await handleSend(args as { to: string; message: string });
      case 'swarm_receive':
        return await handleReceive();
      case 'swarm_lock':
        return await handleLock(args as { resource: string; ttlMs?: number });
      case 'swarm_unlock':
        return await handleUnlock(args as { resource: string });
      case 'swarm_heartbeat':
        return await handleHeartbeat();
      case 'swarm_plan_execute':
        return await handlePlanExecute(args as {
          planDir: string;
          resumePhase?: number;
          retryTasks?: string[];
          skipTasks?: string[];
        });
      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
});

// ─── Handlers ───

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

// ── Orchestrator tools ──

async function handleInit() {
  const client = await getClient();
  const health = await client.health();
  return ok({ status: 'running', url: (client as unknown as { baseUrl: string }).baseUrl ?? 'connected', health });
}

async function handleCreateTasks(args: { tasks: Array<{ id: string; description: string; phase?: number; prompt: string }> }) {
  const client = await getClient();
  const created = await client.createTasks(args.tasks);
  return ok({ created: created.length, tasks: created });
}

async function handleSpawn(args: { count: number; role?: string }) {
  const rawCount = Number(args.count);
  const count = Math.min(Math.max(Number.isFinite(rawCount) ? rawCount : 1, 1), 10);
  const role = (args.role ?? 'generalist') as AgentRole;
  const cwd = process.cwd();

  // Ensure coordination server is running
  const client = await getClient();

  const agents: Array<{ name: string; paneId: string }> = [];

  for (let i = 0; i < count; i++) {
    const agentName = `agent-${Date.now()}-${i + 1}`;
    const agentPrompt = buildSpawnPrompt(agentName, role);

    const tmuxAgent = spawner.spawn({
      name: agentName,
      prompt: agentPrompt,
      cwd,
    });

    // Register agent with coordination server
    await client.registerAgent(agentName, role, tmuxAgent.paneId, tmuxAgent.pid);

    agents.push({ name: agentName, paneId: tmuxAgent.paneId });
  }

  spawner.applyTiledLayout();

  return ok({
    spawned: count,
    role,
    agents: agents.map(a => a.name),
    mode: spawner.tmuxAvailable ? 'tmux' : 'background',
  });
}

async function handleStatus() {
  const client = await getClient();
  const [agents, tasks] = await Promise.all([
    client.listAgents(),
    client.listTasks(),
  ]);

  const taskSummary = {
    open: tasks.filter(t => t.status === 'open').length,
    claimed: tasks.filter(t => t.status === 'claimed').length,
    completed: tasks.filter(t => t.status === 'completed').length,
    failed: tasks.filter(t => t.status === 'failed').length,
    total: tasks.length,
  };

  return ok({ agents, tasks: taskSummary, taskDetails: tasks });
}

async function handleResults(args: { task_id?: string }) {
  const client = await getClient();

  if (args.task_id) {
    const task = await client.getTask(args.task_id);
    return ok(task);
  }

  const tasks = await client.listTasks({ status: 'completed' });
  const failed = await client.listTasks({ status: 'failed' });
  return ok({ completed: tasks, failed });
}

async function handleKill(args: { agent?: string }) {
  const killed: string[] = [];

  if (args.agent) {
    spawner.kill(args.agent);
    killed.push(args.agent);
  } else {
    const allKilled = spawner.killAll();
    killed.push(...allKilled);
  }

  return ok({ killed });
}

// ── Agent tools ──

async function handleTaskList() {
  const client = await getClient();
  const tasks = await client.listTasks({ status: 'open' });
  return ok({ tasks });
}

async function handleTaskClaim(args: { task_id: string }) {
  const client = await getClient();
  const agentName = getAgentName();
  const task = await client.claimTask(args.task_id, agentName);

  if (!task) {
    return fail(`Task ${args.task_id} is already claimed or does not exist.`);
  }

  return ok(task);
}

async function handleTaskComplete(args: { task_id: string; result: string; sha?: string }) {
  const client = await getClient();
  const agentName = getAgentName();
  const task = await client.completeTask(args.task_id, agentName, args.result, args.sha);
  return ok(task);
}

async function handleTaskFail(args: { task_id: string; error: string }) {
  const client = await getClient();
  const agentName = getAgentName();
  const task = await client.failTask(args.task_id, agentName, args.error);
  return ok(task);
}

// ── Shared tools ──

async function handleSend(args: { to: string; message: string }) {
  const client = await getClient();
  const from = getAgentName();
  const msg = await client.sendMessage(from, args.to, 'info', args.message);
  return ok({ sent: true, messageId: msg.id, to: args.to });
}

async function handleReceive() {
  const client = await getClient();
  const agentName = getAgentName();
  const result = await client.receiveMessages(agentName, messageOffset);
  messageOffset = result.nextOffset;
  return ok(result);
}

async function handleLock(args: { resource: string; ttlMs?: number }) {
  const client = await getClient();
  const owner = getAgentName();
  const acquired = await client.acquireLock(args.resource, owner, args.ttlMs);

  if (acquired) {
    return ok({ acquired: true, resource: args.resource, owner });
  }
  return fail(`Failed to acquire lock for ${args.resource}. It is held by another agent.`);
}

async function handleUnlock(args: { resource: string }) {
  const client = await getClient();
  const owner = getAgentName();
  const released = await client.releaseLock(args.resource, owner);

  if (released) {
    return ok({ released: true, resource: args.resource });
  }
  return fail(`Failed to release lock for ${args.resource}. You might not be the owner.`);
}

async function handleHeartbeat() {
  const client = await getClient();
  const agentName = getAgentName();
  await client.heartbeat(agentName);
  return ok({ ok: true, agent: agentName });
}

// ─── Plan Execution ───

async function waitForTasksComplete(taskIds: string[], timeoutMs = 600000): Promise<SwarmTask[]> {
  const client = await getClient();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tasks = await Promise.all(taskIds.map(id => client.getTask(id)));
    const allDone = tasks.every(t => t.status === 'completed' || t.status === 'failed');
    if (allDone) return tasks;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Task timeout');
}

async function handlePlanExecute(args: {
  planDir: string;
  resumePhase?: number;
  retryTasks?: string[];
  skipTasks?: string[];
}) {
  const planPath = `${args.planDir}/plan.md`;
  const specPath = `${args.planDir}/spec.md`;

  if (!existsSync(planPath)) {
    return fail(`Plan not found: ${planPath}`);
  }

  const planContent = readFileSync(planPath, 'utf-8');
  const plan = parsePlan(planContent);

  const targetPhaseNum = args.resumePhase ?? findNextPendingPhase(plan);
  if (targetPhaseNum === null) {
    return ok({ status: 'plan_complete', title: plan.title, totalPhases: plan.phases.length });
  }

  const phase = plan.phases.find(p => p.number === targetPhaseNum);
  if (!phase) {
    return fail(`Phase ${targetPhaseNum} not found in plan`);
  }

  // Handle skipped tasks
  if (args.skipTasks?.length) {
    for (const taskId of args.skipTasks) {
      updateTaskStatus(planPath, taskId, 'completed', 'skipped');
    }
  }

  // Re-read after skips
  const freshPlan = parsePlan(readFileSync(planPath, 'utf-8'));
  const freshPhase = freshPlan.phases.find(p => p.number === targetPhaseNum)!;
  let tasks: PlanTask[];

  if (args.retryTasks?.length) {
    tasks = freshPhase.tasks.filter(t => args.retryTasks!.includes(t.id));
  } else {
    tasks = getPendingTasks(freshPhase);
  }

  if (tasks.length === 0) {
    const nextPhase = findNextPendingPhase(freshPlan);
    if (nextPhase === null) {
      return ok({ status: 'plan_complete', title: plan.title, totalPhases: plan.phases.length });
    }
    return ok({
      status: 'phase_already_complete',
      phase: targetPhaseNum,
      phaseName: freshPhase.name,
      nextPhase: { phase: nextPhase, name: freshPlan.phases.find(p => p.number === nextPhase)?.name },
    });
  }

  let spec = '';
  try {
    spec = readFileSync(specPath, 'utf-8');
  } catch { /* spec is optional */ }

  // Mark tasks in progress in plan.md
  for (const task of tasks) {
    updateTaskStatus(planPath, task.id, 'in_progress');
  }

  // Ensure coordination server is running
  const client = await getClient();
  const cwd = process.cwd();
  const startTime = Date.now();

  // Create tasks on the TaskBoard
  const coordTasks = await client.createTasks(
    tasks.map(t => ({
      id: `${targetPhaseNum}-${t.id}`,
      description: t.description,
      phase: targetPhaseNum,
      prompt: buildAgentPrompt(t, spec, freshPhase),
    })),
  );

  const coordTaskIds = coordTasks.map(t => t.id);

  // Spawn agents (one per task)
  const agentNames: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const agentName = `plan-${targetPhaseNum}-${tasks[i].id.replace('.', '-')}`;
    const agentPrompt = buildSpawnPrompt(agentName, 'coder');

    const tmuxAgent = spawner.spawn({
      name: agentName,
      prompt: agentPrompt,
      cwd,
    });

    await client.registerAgent(agentName, 'coder', tmuxAgent.paneId, tmuxAgent.pid);
    agentNames.push(agentName);
  }

  spawner.applyTiledLayout();

  // Poll for completion
  let completedTasks: SwarmTask[];
  try {
    completedTasks = await waitForTasksComplete(coordTaskIds);
  } catch {
    // Timeout — gather whatever state we have
    completedTasks = await Promise.all(coordTaskIds.map(id => client.getTask(id)));
  }

  const duration = Date.now() - startTime;

  // Update plan.md with results
  for (let i = 0; i < tasks.length; i++) {
    const coordTask = completedTasks[i];
    if (coordTask.status === 'completed') {
      updateTaskStatus(planPath, tasks[i].id, 'completed', coordTask.sha);
    } else if (coordTask.status === 'failed') {
      updateTaskStatus(planPath, tasks[i].id, 'failed');
    }
    // If still claimed/open after timeout, mark as failed
    if (coordTask.status === 'open' || coordTask.status === 'claimed') {
      updateTaskStatus(planPath, tasks[i].id, 'failed');
    }
  }

  const failed = completedTasks.filter(t => t.status === 'failed' || t.status === 'open' || t.status === 'claimed');
  const completed = completedTasks.filter(t => t.status === 'completed');

  if (failed.length > 0) {
    return ok({
      status: 'phase_failed',
      phase: targetPhaseNum,
      phaseName: freshPhase.name,
      completedTasks: completed.map(t => ({
        task: t.id,
        description: t.description,
        result: t.result,
      })),
      failedTasks: failed.map(t => ({
        task: t.id,
        description: t.description,
        error: t.error ?? 'Timed out or unclaimed',
      })),
      duration,
    });
  }

  const updatedPlan = parsePlan(readFileSync(planPath, 'utf-8'));
  const nextPhaseNum = findNextPendingPhase(updatedPlan);

  if (nextPhaseNum !== null) {
    const nextPhase = updatedPlan.phases.find(p => p.number === nextPhaseNum);
    return ok({
      status: 'phase_complete',
      phase: targetPhaseNum,
      phaseName: freshPhase.name,
      completedTasks: completed.map(t => ({
        task: t.id,
        description: t.description,
      })),
      nextPhase: {
        phase: nextPhaseNum,
        name: nextPhase?.name,
        taskCount: nextPhase?.tasks.length,
      },
      duration,
    });
  }

  return ok({
    status: 'plan_complete',
    title: plan.title,
    totalPhases: plan.phases.length,
    totalTasks: plan.phases.reduce((sum, p) => sum + p.tasks.length, 0),
    duration,
  });
}

// ─── Prompt builders ───

function buildAgentPrompt(task: PlanTask, spec: string, phase: PlanPhase): string {
  let prompt = `You are working on: ${task.description}\n\n## Context\nThis is Task ${task.id} in Phase "${phase.name}".\n`;

  if (spec) {
    prompt += `\n## Requirements\n${spec}\n`;
  }

  prompt += `\n## Instructions\n- Complete ONLY the task described above\n- Follow existing code conventions\n- Test your changes if applicable\n- Be thorough but focused on this specific task only\n- Do not modify files outside the scope of this task`;

  return prompt;
}

function buildSpawnPrompt(agentName: string, role: string): string {
  return [
    `You are swarm agent "${agentName}" (role: ${role}).`,
    '',
    'Your workflow:',
    '1. Call swarm_task_list to see available tasks',
    '2. Call swarm_task_claim to claim a task',
    '3. Read the task prompt and complete the work',
    '4. Call swarm_task_complete with your result (or swarm_task_fail if you cannot complete it)',
    '5. Call swarm_heartbeat periodically during long tasks',
    '',
    'Use swarm_send/swarm_receive to communicate with other agents if needed.',
    'Use swarm_lock/swarm_unlock if you need exclusive access to a shared resource.',
  ].join('\n');
}

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start gemini-swarm MCP server:', err);
  process.exit(1);
});
