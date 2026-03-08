import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type PhaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanTask {
  id: string;
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
    const titleMatch = line.match(/^#\s+Plan:\s+(.+)$/);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

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

/**
 * Update a task's status in the plan.md file on disk.
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

  const tmpPath = `${planPath}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmpPath, final.join('\n'));
  renameSync(tmpPath, planPath);
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
