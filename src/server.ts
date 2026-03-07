import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TmuxSpawner, type StreamEvent } from './tmux-spawner.js';
import { AgentTracker, type AgentRole } from './agent-tracker.js';
import { MessageBus } from './message-bus.js';
import { InboxWatcher } from './inbox-watcher.js';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePlan,
  updateTaskStatus,
  findNextPendingPhase,
  getPendingTasks,
  type PlanTask,
  type PlanPhase,
} from './plan-parser.js';

const WORK_DIR = '/tmp/gemini-swarm';

const spawner = new TmuxSpawner();
const tracker = new AgentTracker(WORK_DIR);
const messageBus = new MessageBus(WORK_DIR);
const watcher = new InboxWatcher(join(WORK_DIR, 'inbox'));

const server = new Server(
  { name: 'gemini-swarm', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// --- List Tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'swarm_dispatch',
      description: 'Dispatch N parallel Gemini CLI agents. After dispatching, report the result to the user and STOP. Do not automatically call swarm_status or swarm_results — wait for the user to ask.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          count: { type: 'number', description: 'Number of agents to spawn (1-10)', default: 3 },
          prompt: { type: 'string', description: 'The task/prompt for agents' },
          role: {
            type: 'string',
            enum: ['researcher', 'coder', 'reviewer', 'generalist'],
            description: 'Agent role',
            default: 'generalist',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'swarm_status',
      description: 'Get current status of all swarm agents. Only call when the user explicitly asks for status.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'swarm_results',
      description: 'Collect results from completed swarm agents. Only call when the user explicitly asks for results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'string', description: 'Specific task ID to get results for (optional)' },
        },
      },
    },
    {
      name: 'swarm_send',
      description: 'Send a message to a specific agent via JSONL inbox',
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
      name: 'swarm_kill',
      description: 'Kill swarm agents (specific or all)',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent: { type: 'string', description: 'Agent name to kill (omit for all)' },
        },
      },
    },
    {
      name: 'swarm_plan_execute',
      description:
        'Execute a structured plan phase-by-phase. Dispatches all tasks in the current phase as parallel agents, waits for completion, updates plan.md status markers, and returns. Call this once per phase — it returns after each phase for a verification checkpoint.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          planDir: {
            type: 'string',
            description: 'Path to the plan directory containing plan.md and spec.md (e.g. swarm/plans/oauth_20260307)',
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

  switch (name) {
    case 'swarm_dispatch':
      return handleDispatch(args as { count?: number; prompt: string; role?: string });
    case 'swarm_status':
      return handleStatus();
    case 'swarm_results':
      return handleResults(args as { task_id?: string });
    case 'swarm_send':
      return handleSend(args as { to: string; message: string });
    case 'swarm_kill':
      return handleKill(args as { agent?: string });
    case 'swarm_plan_execute':
      return handlePlanExecute(args as {
        planDir: string;
        resumePhase?: number;
        retryTasks?: string[];
        skipTasks?: string[];
      });
    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

// --- Handlers ---

async function handleDispatch(args: { count?: number; prompt: string; role?: string }) {
  const count = Math.min(Math.max(args.count ?? 3, 1), 10);
  const role = (args.role ?? 'generalist') as AgentRole;
  const cwd = process.cwd();

  const agents: Array<{ name: string; paneId: string; status: string; taskId: string }> = [];

  for (let i = 0; i < count; i++) {
    const agentName = `agent-${i + 1}`;
    const agentPrompt = count > 1
      ? `You are agent ${i + 1} of ${count} (role: ${role}). Task:\n${args.prompt}\n\nFocus on your portion. Be concise.`
      : args.prompt;

    const tmuxAgent = spawner.spawn({ name: agentName, prompt: agentPrompt, cwd });
    const tracked = tracker.register({
      name: agentName,
      role,
      prompt: agentPrompt,
      paneId: tmuxAgent.paneId,
      pid: tmuxAgent.pid,
    });

    tracker.updateStatus(agentName, 'running');

    // Monitor for completion
    monitorAgent(agentName, tmuxAgent.process, spawner.tmuxAvailable);

    agents.push({
      name: agentName,
      paneId: tmuxAgent.paneId,
      status: 'running',
      taskId: tracked.taskId,
    });
  }

  // Apply tiled layout so all panes are evenly distributed
  spawner.applyTiledLayout();

  const mode = spawner.tmuxAvailable ? 'tmux panes' : 'background processes';
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        dispatched: count,
        mode,
        role,
        agents,
      }, null, 2),
    }],
  };
}

function monitorAgent(name: string, proc: import('node:child_process').ChildProcess, useTmux: boolean): void {
  const outputFile = TmuxSpawner.outputPath(name);

  if (useTmux) {
    // proc = tmux wait-for process. Closes exactly when gemini finishes.
    proc.on('close', () => {
      resolveFromFile(name, outputFile);
      spawner.removePaneEntry(name);
    });
  } else {
    // Background mode: collect stdout directly
    let stdout = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.on('close', () => {
      resolveFromRaw(name, stdout);
    });
  }

  proc.on('error', (err) => {
    tracker.updateStatus(name, 'failed', { error: err.message });
  });
}

function resolveFromFile(name: string, outputFile: string): void {
  try {
    const raw = readFileSync(outputFile, 'utf-8');
    resolveFromRaw(name, raw);
  } catch (err) {
    tracker.updateStatus(name, 'failed', { error: `Output read error: ${err}` });
  }
  try { rmSync(outputFile, { force: true }); } catch { /* ignore */ }
}

function resolveFromRaw(name: string, raw: string): void {
  const events = TmuxSpawner.parseStreamEvents(raw);
  const response = TmuxSpawner.extractResponse(events);
  const errorEvent = events.find(e => e.type === 'error');

  if (errorEvent) {
    tracker.updateStatus(name, 'failed', { error: errorEvent.error ?? 'Unknown error', response });
  } else if (response) {
    tracker.updateStatus(name, 'completed', { response });
  } else {
    tracker.updateStatus(name, 'failed', { error: 'Agent exited without result' });
  }
}

async function handleStatus() {
  const agents = tracker.getAllAgents();

  if (agents.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No swarm agents active.' }] };
  }

  const statusTable = agents.map(a => ({
    name: a.name,
    role: a.role,
    status: a.status,
    taskId: a.taskId,
    elapsed: a.completedAt
      ? `${a.durationMs}ms`
      : `${Date.now() - new Date(a.startedAt).getTime()}ms (running)`,
    prompt: a.prompt.slice(0, 100) + (a.prompt.length > 100 ? '...' : ''),
  }));

  const running = agents.filter(a => a.status === 'running' || a.status === 'spawning');
  const completed = agents.filter(a => a.status === 'completed' || a.status === 'failed');

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ agents: statusTable, tmux: spawner.tmuxAvailable }, null, 2),
    }],
    // Mark as error when all agents still running to discourage LLM from re-polling
    ...(running.length > 0 && completed.length === 0 ? { isError: true } : {}),
  };
}

async function handleResults(args: { task_id?: string }) {
  if (args.task_id) {
    const result = tracker.getResultByTaskId(args.task_id);
    if (!result) {
      return { content: [{ type: 'text' as const, text: `No result found for task ${args.task_id}` }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  }

  // Return all results — from both tracker memory and saved files
  const agents = tracker.getAllAgents();
  const results = agents
    .filter(a => a.status === 'completed' || a.status === 'failed')
    .map(a => ({
      taskId: a.taskId,
      agent: a.name,
      role: a.role,
      status: a.status,
      response: a.response ?? '',
      error: a.error,
      duration: a.durationMs ?? 0,
    }));

  if (results.length === 0) {
    const running = agents.filter(a => a.status === 'running' || a.status === 'spawning');
    if (running.length > 0) {
      return {
        content: [{
          type: 'text' as const,
          text: `All ${running.length} agent(s) still running. Results will appear when agents complete.`,
        }],
        isError: true,
      };
    }
    return { content: [{ type: 'text' as const, text: 'No results available.' }] };
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify({ results }, null, 2) }] };
}

async function handleSend(args: { to: string; message: string }) {
  messageBus.send({
    from: 'orchestrator',
    to: args.to,
    type: 'info',
    payload: args.message,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify({ sent: true, to: args.to }) }] };
}

async function handleKill(args: { agent?: string }) {
  const killed: string[] = [];

  if (args.agent) {
    // Kill specific agent
    const agent = tracker.getAgent(args.agent);
    if (agent) {
      if (agent.pid) {
        try { process.kill(agent.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      spawner.kill(args.agent);
      tracker.updateStatus(args.agent, 'killed');
      killed.push(args.agent);
    }
  } else {
    // Kill all
    const agents = tracker.getRunningAgents();
    for (const agent of agents) {
      if (agent.pid) {
        try { process.kill(agent.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      spawner.kill(agent.name);
      tracker.updateStatus(agent.name, 'killed');
      killed.push(agent.name);
    }
  }

  // Clean up output files
  for (const name of killed) {
    try { rmSync(TmuxSpawner.outputPath(name), { force: true }); } catch { /* ignore */ }
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify({ killed }) }] };
}

// --- Plan Execution ---

async function handlePlanExecute(args: {
  planDir: string;
  resumePhase?: number;
  retryTasks?: string[];
  skipTasks?: string[];
}) {
  const planPath = `${args.planDir}/plan.md`;
  const specPath = `${args.planDir}/spec.md`;

  if (!existsSync(planPath)) {
    return {
      content: [{ type: 'text' as const, text: `Plan not found: ${planPath}` }],
      isError: true,
    };
  }

  const planContent = readFileSync(planPath, 'utf-8');
  const plan = parsePlan(planContent);

  const targetPhaseNum = args.resumePhase ?? findNextPendingPhase(plan);
  if (targetPhaseNum === null) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ status: 'plan_complete', title: plan.title, totalPhases: plan.phases.length }),
      }],
    };
  }

  const phase = plan.phases.find(p => p.number === targetPhaseNum);
  if (!phase) {
    return {
      content: [{ type: 'text' as const, text: `Phase ${targetPhaseNum} not found in plan` }],
      isError: true,
    };
  }

  if (args.skipTasks?.length) {
    for (const taskId of args.skipTasks) {
      updateTaskStatus(planPath, taskId, 'completed', 'skipped');
    }
  }

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
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'plan_complete', title: plan.title, totalPhases: plan.phases.length }),
        }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'phase_already_complete',
          phase: targetPhaseNum,
          phaseName: freshPhase.name,
          nextPhase: { phase: nextPhase, name: freshPlan.phases.find(p => p.number === nextPhase)?.name },
        }),
      }],
    };
  }

  let spec = '';
  try {
    spec = readFileSync(specPath, 'utf-8');
  } catch { /* spec is optional */ }

  for (const task of tasks) {
    updateTaskStatus(planPath, task.id, 'in_progress');
  }

  const cwd = process.cwd();
  const startTime = Date.now();
  const agentPromises: Array<{
    task: PlanTask;
    name: string;
    promise: Promise<{ success: boolean; response?: string; error?: string }>;
  }> = [];

  for (const task of tasks) {
    const agentName = `plan-${targetPhaseNum}-${task.id.replace('.', '-')}`;
    const agentPrompt = buildAgentPrompt(task, spec, freshPhase);

    const tmuxAgent = spawner.spawn({ name: agentName, prompt: agentPrompt, cwd });
    tracker.register({
      name: agentName,
      role: 'coder',
      prompt: agentPrompt,
      paneId: tmuxAgent.paneId,
      pid: tmuxAgent.pid,
    });
    tracker.updateStatus(agentName, 'running');

    const promise = new Promise<{ success: boolean; response?: string; error?: string }>((resolve) => {
      const outputFile = TmuxSpawner.outputPath(agentName);

      if (spawner.tmuxAvailable) {
        tmuxAgent.process.on('close', () => {
          try {
            const raw = readFileSync(outputFile, 'utf-8');
            const events = TmuxSpawner.parseStreamEvents(raw);
            const response = TmuxSpawner.extractResponse(events);
            const errorEvent = events.find(e => e.type === 'error');

            if (errorEvent) {
              tracker.updateStatus(agentName, 'failed', { error: errorEvent.error ?? 'Unknown error', response });
              resolve({ success: false, error: errorEvent.error ?? 'Unknown error', response });
            } else if (response) {
              tracker.updateStatus(agentName, 'completed', { response });
              resolve({ success: true, response });
            } else {
              tracker.updateStatus(agentName, 'failed', { error: 'Agent exited without result' });
              resolve({ success: false, error: 'Agent exited without result' });
            }
          } catch (err) {
            tracker.updateStatus(agentName, 'failed', { error: `Output read error: ${err}` });
            resolve({ success: false, error: `Output read error: ${err}` });
          }
          try { rmSync(outputFile, { force: true }); } catch { /* ignore */ }
          spawner.removePaneEntry(agentName);
        });
      } else {
        let stdout = '';
        tmuxAgent.process.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        tmuxAgent.process.on('close', () => {
          const events = TmuxSpawner.parseStreamEvents(stdout);
          const response = TmuxSpawner.extractResponse(events);
          const errorEvent = events.find(e => e.type === 'error');

          if (errorEvent) {
            tracker.updateStatus(agentName, 'failed', { error: errorEvent.error ?? 'Unknown error', response });
            resolve({ success: false, error: errorEvent.error ?? 'Unknown error', response });
          } else if (response) {
            tracker.updateStatus(agentName, 'completed', { response });
            resolve({ success: true, response });
          } else {
            tracker.updateStatus(agentName, 'failed', { error: 'Agent exited without result' });
            resolve({ success: false, error: 'Agent exited without result' });
          }
        });
      }

      tmuxAgent.process.on('error', (err) => {
        tracker.updateStatus(agentName, 'failed', { error: err.message });
        resolve({ success: false, error: err.message });
      });
    });

    agentPromises.push({ task, name: agentName, promise });
  }

  spawner.applyTiledLayout();

  const results = await Promise.all(
    agentPromises.map(async ({ task, name, promise }) => {
      const result = await promise;
      return { taskId: task.id, taskDesc: task.description, agent: name, ...result };
    })
  );

  const duration = Date.now() - startTime;

  for (const result of results) {
    if (result.success) {
      updateTaskStatus(planPath, result.taskId, 'completed');
    } else {
      updateTaskStatus(planPath, result.taskId, 'failed');
    }
  }

  const failed = results.filter(r => !r.success);
  const completed = results.filter(r => r.success);

  if (failed.length > 0) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'phase_failed',
          phase: targetPhaseNum,
          phaseName: freshPhase.name,
          completedTasks: completed.map(r => ({
            task: `Task ${r.taskId}: ${r.taskDesc}`,
            agent: r.agent,
          })),
          failedTasks: failed.map(r => ({
            task: `Task ${r.taskId}: ${r.taskDesc}`,
            agent: r.agent,
            error: r.error,
          })),
          duration,
        }, null, 2),
      }],
    };
  }

  const updatedPlan = parsePlan(readFileSync(planPath, 'utf-8'));
  const nextPhaseNum = findNextPendingPhase(updatedPlan);

  if (nextPhaseNum !== null) {
    const nextPhase = updatedPlan.phases.find(p => p.number === nextPhaseNum);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'phase_complete',
          phase: targetPhaseNum,
          phaseName: freshPhase.name,
          completedTasks: completed.map(r => ({
            task: `Task ${r.taskId}: ${r.taskDesc}`,
            agent: r.agent,
            duration: tracker.getAgent(r.agent)?.durationMs,
          })),
          nextPhase: {
            phase: nextPhaseNum,
            name: nextPhase?.name,
            taskCount: nextPhase?.tasks.length,
          },
          duration,
        }, null, 2),
      }],
    };
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'plan_complete',
        title: plan.title,
        totalPhases: plan.phases.length,
        totalTasks: plan.phases.reduce((sum, p) => sum + p.tasks.length, 0),
        duration,
      }, null, 2),
    }],
  };
}

function buildAgentPrompt(task: PlanTask, spec: string, phase: PlanPhase): string {
  let prompt = `You are working on: ${task.description}\n\n## Context\nThis is Task ${task.id} in Phase "${phase.name}".\n`;

  if (spec) {
    prompt += `\n## Requirements\n${spec}\n`;
  }

  prompt += `\n## Instructions\n- Complete ONLY the task described above\n- Follow existing code conventions\n- Test your changes if applicable\n- Be thorough but focused on this specific task only\n- Do not modify files outside the scope of this task`;

  return prompt;
}

// --- Start ---
async function main() {
  // Start message watcher
  watcher.on('message', (agentName) => {
    if (agentName === 'orchestrator') {
      const messages = messageBus.receive('orchestrator');
      for (const msg of messages) {
        // Log received messages for now
        console.error(`[orchestrator] Inbox: ${JSON.stringify(msg)}`);
      }
    }
  });
  watcher.start();

  // Re-monitor running agents
  const runningAgents = tracker.getRunningAgents();
  if (runningAgents.length > 0) {
    console.log(`Re-monitoring ${runningAgents.length} running agents...`);
    for (const agent of runningAgents) {
      if (agent.paneId && spawner.tmuxAvailable && !agent.paneId.startsWith('bg-')) {
        spawner.reRegister(agent.name, agent.paneId);
        const waiter = spawner.getWaiter(agent.name);
        monitorAgent(agent.name, waiter, true);
      } else if (agent.pid && !spawner.tmuxAvailable) {
        // For background processes, we can't easily re-attach stdout,
        // but we can at least wait for them to finish if they are still alive.
        // For now, mark them as failed as we can't recover stdout.
        tracker.updateStatus(agent.name, 'failed', { error: 'Server restarted, background agent lost' });
      }
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Failed to start gemini-swarm MCP server:', err);
  process.exit(1);
});
