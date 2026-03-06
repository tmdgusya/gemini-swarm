# Structured Task Decomposition Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `/swarm:plan` command and `swarm_plan_execute` MCP tool so gemini-swarm can structurally decompose user requests into Phases > Tasks and execute them with parallel dispatch per phase, following Google Conductor patterns.

**Architecture:** A new `plan-parser.ts` module handles markdown plan parsing and status updates. The existing `server.ts` gets a `swarm_plan_execute` tool that reads a plan, dispatches all tasks in a phase via the existing `handleDispatch` flow, waits for completion, updates plan.md status markers, and returns control to the LLM at phase boundaries for verification checkpoints.

**Tech Stack:** TypeScript, Node.js `node:fs`, MCP SDK, existing TmuxSpawner/AgentTracker

**Design Doc:** `docs/plans/2026-03-07-structured-task-decomposition-design.md`

---

### Task 1: Plan Parser — Types and `parsePlan`

**Files:**
- Create: `src/plan-parser.ts`

**Step 1: Create plan-parser.ts with types and parsePlan function**

```typescript
import { readFileSync, writeFileSync } from 'node:fs';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanTask {
  id: string;            // "1.1", "2.3"
  description: string;
  status: TaskStatus;
  sha?: string;
  agent?: string;
}

export interface PlanPhase {
  number: number;
  name: string;
  tasks: PlanTask[];
  status: PhaseStatus;
}

export interface Plan {
  title: string;
  phases: PlanPhase[];
}

const STATUS_MAP: Record<string, TaskStatus> = {
  ' ': 'pending',
  '~': 'in_progress',
  'x': 'completed',
  '!': 'failed',
};

/**
 * Parse a plan.md markdown string into a structured Plan object.
 *
 * Expected format:
 *   # Plan: <Title>
 *   ## Phase 1: <Name>
 *   - [ ] Task 1.1: <description>
 *   - [x] Task 1.2: <description>  <!-- sha: abc1234 -->
 */
export function parsePlan(markdown: string): Plan {
  const lines = markdown.split('\n');
  let title = '';
  const phases: PlanPhase[] = [];
  let currentPhase: PlanPhase | null = null;

  for (const line of lines) {
    // Match title: # Plan: <Title>
    const titleMatch = line.match(/^#\s+Plan:\s+(.+)$/);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    // Match phase: ## Phase N: <Name>
    const phaseMatch = line.match(/^##\s+Phase\s+(\d+):\s+(.+?)(?:\s+[✅🔄❌])?$/);
    if (phaseMatch) {
      currentPhase = {
        number: parseInt(phaseMatch[1], 10),
        name: phaseMatch[2].trim(),
        tasks: [],
        status: 'pending',
      };
      phases.push(currentPhase);
      continue;
    }

    // Match task: - [x] Task N.M: <description>  <!-- sha: abc -->
    const taskMatch = line.match(
      /^-\s+\[([x~! ])\]\s+Task\s+([\d.]+):\s+(.+?)(?:\s+<!--\s*sha:\s*(\S+)\s*-->)?$/
    );
    if (taskMatch && currentPhase) {
      const marker = taskMatch[1];
      const status = STATUS_MAP[marker] ?? 'pending';
      currentPhase.tasks.push({
        id: taskMatch[2],
        description: taskMatch[3].trim(),
        status,
        sha: taskMatch[4],
      });
    }
  }

  // Derive phase status from tasks
  for (const phase of phases) {
    if (phase.tasks.length === 0) {
      phase.status = 'pending';
    } else if (phase.tasks.every(t => t.status === 'completed')) {
      phase.status = 'completed';
    } else if (phase.tasks.some(t => t.status === 'failed')) {
      phase.status = 'failed';
    } else if (phase.tasks.some(t => t.status === 'in_progress')) {
      phase.status = 'in_progress';
    } else {
      phase.status = 'pending';
    }
  }

  return { title, phases };
}
```

**Step 2: Verify it compiles**

Run: `cd /home/roach/gemini-swarm && npx tsc --noEmit src/plan-parser.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/plan-parser.ts
git commit -m "feat: add plan-parser module with types and parsePlan"
```

---

### Task 2: Plan Parser — `updateTaskStatus` and `updatePlanFile`

**Files:**
- Modify: `src/plan-parser.ts`

**Step 1: Add updateTaskStatus and helper functions**

Append to `src/plan-parser.ts`:

```typescript
const REVERSE_STATUS_MAP: Record<TaskStatus, string> = {
  pending: ' ',
  in_progress: '~',
  completed: 'x',
  failed: '!',
};

const PHASE_EMOJI: Record<PhaseStatus, string> = {
  pending: '',
  in_progress: ' 🔄',
  completed: ' ✅',
  failed: ' ❌',
};

/**
 * Update a task's status in the plan.md file on disk.
 * Rewrites the file with the updated checkbox marker and optional SHA comment.
 */
export function updateTaskStatus(
  planPath: string,
  taskId: string,
  status: TaskStatus,
  sha?: string
): void {
  const content = readFileSync(planPath, 'utf-8');
  const lines = content.split('\n');
  const updated: string[] = [];

  for (const line of lines) {
    const taskMatch = line.match(
      /^(-\s+\[)[x~! ](\]\s+Task\s+)([\d.]+)(:\s+.+?)(?:\s+<!--\s*sha:\s*\S+\s*-->)?$/
    );
    if (taskMatch && taskMatch[3] === taskId) {
      const marker = REVERSE_STATUS_MAP[status];
      let newLine = `${taskMatch[1]}${marker}${taskMatch[2]}${taskMatch[3]}${taskMatch[4]}`;
      if (sha) {
        newLine += `  <!-- sha: ${sha} -->`;
      }
      updated.push(newLine);
    } else {
      updated.push(line);
    }
  }

  // Update phase emoji based on new task states
  const plan = parsePlan(updated.join('\n'));
  const final: string[] = [];
  for (const line of updated) {
    const phaseMatch = line.match(/^(##\s+Phase\s+\d+:\s+.+?)(?:\s+[✅🔄❌])?$/);
    if (phaseMatch) {
      const phaseNum = parseInt(line.match(/Phase\s+(\d+)/)?.[1] ?? '0', 10);
      const phase = plan.phases.find(p => p.number === phaseNum);
      const emoji = phase ? PHASE_EMOJI[phase.status] : '';
      final.push(`${phaseMatch[1]}${emoji}`);
    } else {
      final.push(line);
    }
  }

  writeFileSync(planPath, final.join('\n'));
}

/**
 * Find the next phase that has pending or failed tasks.
 * Returns the phase number (1-indexed) or null if all complete.
 */
export function findNextPendingPhase(plan: Plan): number | null {
  for (const phase of plan.phases) {
    if (phase.status !== 'completed') {
      return phase.number;
    }
  }
  return null;
}

/**
 * Get tasks that need to be dispatched (pending or failed).
 */
export function getPendingTasks(phase: PlanPhase): PlanTask[] {
  return phase.tasks.filter(t => t.status === 'pending' || t.status === 'failed');
}
```

**Step 2: Verify it compiles**

Run: `cd /home/roach/gemini-swarm && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/plan-parser.ts
git commit -m "feat: add updateTaskStatus, findNextPendingPhase, getPendingTasks"
```

---

### Task 3: Add `swarm_plan_execute` Tool Registration

**Files:**
- Modify: `src/server.ts:1-10` (imports)
- Modify: `src/server.ts:24-82` (tool list)
- Modify: `src/server.ts:85-102` (call tool switch)

**Step 1: Add imports at top of server.ts**

Add after the existing imports (line 10):

```typescript
import { mkdirSync, existsSync } from 'node:fs';
import {
  parsePlan,
  updateTaskStatus,
  findNextPendingPhase,
  getPendingTasks,
  type Plan,
  type PlanPhase,
  type PlanTask,
} from './plan-parser.js';
```

Note: `readFileSync` and `rmSync` are already imported. Add `mkdirSync` and `existsSync` to the existing destructured import from `'node:fs'`.

**Step 2: Add tool definition to ListToolsRequestSchema handler**

Add this entry to the `tools` array (after the `swarm_kill` entry, before the closing `]`):

```typescript
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
```

**Step 3: Add case to the switch statement in CallToolRequestSchema handler**

Add before the `default` case:

```typescript
    case 'swarm_plan_execute':
      return handlePlanExecute(args as {
        planDir: string;
        resumePhase?: number;
        retryTasks?: string[];
        skipTasks?: string[];
      });
```

**Step 4: Verify it compiles (will fail — handlePlanExecute doesn't exist yet)**

Run: `cd /home/roach/gemini-swarm && npx tsc --noEmit`
Expected: Error about `handlePlanExecute` not found — that's OK, we'll add it in the next task.

**Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: register swarm_plan_execute tool definition and routing"
```

---

### Task 4: Implement `handlePlanExecute` Handler

**Files:**
- Modify: `src/server.ts` (add handler function before `// --- Start ---` section at line 323)

**Step 1: Add the handlePlanExecute function**

Insert before the `// --- Start ---` comment (line 323):

```typescript
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

  // Parse plan
  const planContent = readFileSync(planPath, 'utf-8');
  const plan = parsePlan(planContent);

  // Determine which phase to execute
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

  // Handle skip tasks
  if (args.skipTasks?.length) {
    for (const taskId of args.skipTasks) {
      updateTaskStatus(planPath, taskId, 'completed', 'skipped');
    }
  }

  // Determine tasks to dispatch
  // Re-read plan after skip updates
  const freshPlan = parsePlan(readFileSync(planPath, 'utf-8'));
  const freshPhase = freshPlan.phases.find(p => p.number === targetPhaseNum)!;
  let tasks: PlanTask[];

  if (args.retryTasks?.length) {
    tasks = freshPhase.tasks.filter(t => args.retryTasks!.includes(t.id));
  } else {
    tasks = getPendingTasks(freshPhase);
  }

  if (tasks.length === 0) {
    // Phase already complete, find next
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

  // Read spec for agent prompt context
  let spec = '';
  try {
    spec = readFileSync(specPath, 'utf-8');
  } catch { /* spec is optional */ }

  // Mark tasks in-progress
  for (const task of tasks) {
    updateTaskStatus(planPath, task.id, 'in_progress');
  }

  // Dispatch each task as a separate agent
  const cwd = process.cwd();
  const startTime = Date.now();
  const agentPromises: Array<{
    task: PlanTask;
    name: string;
    promise: Promise<{ success: boolean; response?: string; error?: string }>;
  }> = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
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

    // Create a promise that resolves when agent completes
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

  // Apply tiled layout
  spawner.applyTiledLayout();

  // Wait for all agents to complete
  const results = await Promise.all(
    agentPromises.map(async ({ task, name, promise }) => {
      const result = await promise;
      return { taskId: task.id, taskDesc: task.description, agent: name, ...result };
    })
  );

  const duration = Date.now() - startTime;

  // Update plan.md with results
  for (const result of results) {
    if (result.success) {
      updateTaskStatus(planPath, result.taskId, 'completed');
    } else {
      updateTaskStatus(planPath, result.taskId, 'failed');
    }
  }

  // Check for failures
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

  // Check if more phases remain
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
  let prompt = `You are working on: ${task.description}

## Context
This is Task ${task.id} in Phase "${phase.name}".
`;

  if (spec) {
    prompt += `
## Requirements
${spec}
`;
  }

  prompt += `
## Instructions
- Complete ONLY the task described above
- Follow existing code conventions
- Test your changes if applicable
- Be thorough but focused on this specific task only
- Do not modify files outside the scope of this task`;

  return prompt;
}
```

**Step 2: Verify it compiles**

Run: `cd /home/roach/gemini-swarm && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat: implement handlePlanExecute with phase-by-phase execution"
```

---

### Task 5: Create `/swarm:plan` Command

**Files:**
- Create: `commands/swarm/plan.toml`

**Step 1: Create the plan.toml command file**

```toml
description = "Decompose a task into phases and dispatch agents (Conductor-style)"
prompt = """
You are a **Task Decomposition Specialist** for the Gemini Swarm framework.

The user wants to accomplish: {{args}}

Follow this process strictly:

---

## Step 1: Clarify Requirements

Ask clarifying questions to fully understand the task. Rules:
- Ask **ONE question at a time** using the `ask_user` tool
- Prefer **multiple choice** questions when possible
- Ask 2-5 questions total (fewer for simple tasks, more for complex ones)
- Focus on: scope, constraints, dependencies, existing code context

## Step 2: Generate Spec

After gathering enough information, create a spec following this format:

```markdown
# Spec: <Title>

## Overview
<Brief description of what we're building and why>

## Functional Requirements
- FR1: <requirement>
- FR2: <requirement>

## Non-Functional Requirements
- NFR1: <requirement>

## Acceptance Criteria
- [ ] <criterion>

## Out of Scope
- <excluded item>
```

Present the spec to the user and ask for approval using `ask_user`.

## Step 3: Generate Plan

After spec approval, create a phased plan:

```markdown
# Plan: <Title>

## Phase 1: <Phase Name>
- [ ] Task 1.1: <description>
- [ ] Task 1.2: <description>

## Phase 2: <Phase Name>
- [ ] Task 2.1: <description>
```

Rules for plan creation:
- **Phases are sequential** — Phase 2 depends on Phase 1 being complete
- **Tasks within a Phase are parallel** — they must be independent of each other
- Each task should be completable by a single agent in one session
- Task descriptions must be specific and actionable (not vague)
- Use `<shortname>_YYYYMMDD` format for the plan ID (e.g. `oauth_20260307`)

Present the plan to the user and ask for approval using `ask_user`.

## Step 4: Save and Execute

After plan approval:

1. Create the plan directory: `swarm/plans/<plan_id>/`
2. Save `spec.md` and `plan.md` using file tools
3. Save `metadata.json` with:
   ```json
   {
     "id": "<plan_id>",
     "description": "<description>",
     "status": "pending",
     "currentPhase": 0,
     "createdAt": "<ISO timestamp>"
   }
   ```
4. Call `swarm_plan_execute` with `planDir` set to the plan directory path

## Step 5: Phase Verification Checkpoints

After `swarm_plan_execute` returns with `phase_complete`:
1. Present the phase results to the user
2. Ask: "Phase N complete. Proceed to Phase N+1?" using `ask_user`
3. If approved: call `swarm_plan_execute` with `resumePhase` for next phase
4. If rejected: ask what to adjust

If `swarm_plan_execute` returns `phase_failed`:
1. Show which tasks failed and why
2. Ask the user to choose: Retry / Skip / Abort using `ask_user`
3. Call `swarm_plan_execute` with appropriate `retryTasks` or `skipTasks`

After `plan_complete`: present a final summary of all phases and results.
"""
```

**Step 2: Commit**

```bash
git add commands/swarm/plan.toml
git commit -m "feat: add /swarm:plan command for structured task decomposition"
```

---

### Task 6: Update GEMINI.md

**Files:**
- Modify: `GEMINI.md`

**Step 1: Add new tool and command documentation**

Replace the full contents of `GEMINI.md` with:

```markdown
# Gemini Swarm Extension

You have access to swarm tools that let you dispatch multiple Gemini CLI agents in parallel via tmux panes.

## Available Tools

- **swarm_dispatch(count, prompt, role?)** — Spawn N agents to work on a task in parallel tmux panes
- **swarm_plan_execute(planDir, resumePhase?, retryTasks?, skipTasks?)** — Execute a structured plan phase-by-phase. Dispatches all tasks in a phase as parallel agents, waits for completion, updates plan.md, and returns at phase boundaries for verification checkpoints.
- **swarm_status()** — Check the current status of all running/completed agents
- **swarm_results(task_id?)** — Collect results from completed agents
- **swarm_send(to, message)** — Send a message to a specific agent via JSONL inbox
- **swarm_kill(agent?)** — Kill a specific agent or all agents

## Usage Patterns

### Structured Task Decomposition (Recommended)
For complex multi-step tasks, use the plan workflow:
1. `/swarm:plan <description>` — Interactive Q&A, generates spec + plan
2. Plan executes automatically phase-by-phase with verification checkpoints
3. Monitor with `/swarm:status`, collect with `/swarm:results`

### Quick Parallel Dispatch
For simple parallel tasks:
1. Use `swarm_dispatch` with one agent per topic
2. Monitor with `swarm_status`
3. Collect with `swarm_results`

## Slash Commands
- `/swarm:plan <description>` — Structured decomposition and parallel execution
- `/swarm:dispatch <N> <prompt>` — Quick dispatch
- `/swarm:status` — Quick status check
- `/swarm:results` — Collect results
- `/swarm:kill` — Stop all agents

## Plan File Format
Plans are stored in `swarm/plans/<plan_id>/` with:
- `spec.md` — Requirements (Conductor format: Overview, FR, NFR, AC, Out of Scope)
- `plan.md` — Phased task checklist (Phase > Task, Conductor markers: [ ] [~] [x] [!])
- `metadata.json` — Execution state

## Notes
- Agents run as `gemini -p "..." -y -o stream-json` in tmux panes
- Results are stored in `/tmp/gemini-swarm/results/`
- Inter-agent messages go to `/tmp/gemini-swarm/inbox/`
- If tmux is not available, agents run as background processes
```

**Step 2: Commit**

```bash
git add GEMINI.md
git commit -m "docs: update GEMINI.md with plan execution tool and workflow"
```

---

### Task 7: Build and Smoke Test

**Files:**
- No new files

**Step 1: Build the project**

Run: `cd /home/roach/gemini-swarm && npm run build`
Expected: Compiles cleanly with no errors, `dist/` directory updated

**Step 2: Verify the built output exists**

Run: `ls -la dist/plan-parser.js dist/plan-parser.d.ts dist/server.js`
Expected: All files present with recent timestamps

**Step 3: Create a test plan directory for manual testing**

```bash
mkdir -p /home/roach/gemini-swarm/swarm/plans/test_20260307
```

Create `swarm/plans/test_20260307/spec.md`:
```markdown
# Spec: Test Plan

## Overview
A test plan to verify the plan execution system works.

## Functional Requirements
- FR1: Tasks execute in parallel within a phase
- FR2: Phases execute sequentially

## Acceptance Criteria
- [ ] Phase 1 completes before Phase 2 starts

## Out of Scope
- Production deployment
```

Create `swarm/plans/test_20260307/plan.md`:
```markdown
# Plan: Test Plan

## Phase 1: Setup
- [ ] Task 1.1: Echo "hello from task 1.1"
- [ ] Task 1.2: Echo "hello from task 1.2"

## Phase 2: Verification
- [ ] Task 2.1: Echo "phase 2 started"
```

**Step 4: Add swarm/plans to .gitignore**

Append to `.gitignore`:
```
swarm/plans/
```

This prevents user-created plans from polluting the extension repo. Users will track plans in their own project repos.

**Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: add swarm/plans/ to gitignore"
```

**Step 6: Clean up test fixtures**

```bash
rm -rf /home/roach/gemini-swarm/swarm/plans/test_20260307
```

---

### Task 8: Final Build and Integration Verification

**Step 1: Full clean build**

```bash
cd /home/roach/gemini-swarm && rm -rf dist && npm run build
```
Expected: Clean compilation

**Step 2: Verify MCP server starts without errors**

```bash
cd /home/roach/gemini-swarm && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | timeout 3 node dist/server.js 2>/dev/null || true
```
Expected: JSON response with server capabilities (or clean timeout — no crash)

**Step 3: Verify tool list includes new tool**

```bash
cd /home/roach/gemini-swarm && echo -e '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | timeout 3 node dist/server.js 2>/dev/null | grep -o 'swarm_plan_execute' || true
```
Expected: `swarm_plan_execute` appears in output

**Step 4: Commit — no changes expected but verify clean state**

```bash
git status
```
Expected: `nothing to commit, working tree clean`
