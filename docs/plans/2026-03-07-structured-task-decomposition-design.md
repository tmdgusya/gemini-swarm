# Design: Structured Task Decomposition for Gemini Swarm

> Conductor's brain + Swarm's muscles

## Background

현재 gemini-swarm은 `/swarm:dispatch`로 N개의 에이전트를 병렬 spawn하지만, 유저가 직접 task를 정의해야 합니다. Google의 Conductor extension은 구조적 분해(Context → Spec → Plan → Implement)를 잘 구현했으나 단일 에이전트 순차 실행만 지원합니다.

이 설계는 Conductor의 구조적 분해 패턴을 차용하되, Phase 내 Task를 병렬 dispatch하는 하이브리드 접근을 취합니다.

## Design Decisions

| 결정 | 선택 | 근거 |
|------|------|------|
| 진입점 | `/swarm:plan` → `/swarm:dispatch` 분리 | Planning과 execution을 독립적으로 실행 가능 |
| 분해 깊이 | Phase > Task (2계층) | 병렬 dispatch 단위가 명확, 불필요한 복잡도 제거 |
| Q&A 방식 | Gemini 내장 `ask_user` 도구 | MCP 서버 변경 불필요, 프롬프트 엔지니어링으로 해결 |
| 오케스트레이션 | MCP 서버 (`swarm_plan_execute`) | LLM 기반보다 안정적인 Phase 순차/Task 병렬 제어 |
| Plan 저장소 | 프로젝트 내 `swarm/plans/<plan_id>/` | Git 추적 가능, 세션 간 지속성 확보 |
| 실패 처리 | LLM에 제어권 반환 → 유저 확인 | 안전하고 유연한 복구 |

## Architecture

### Overall Flow

```
User → /swarm:plan "Add OAuth"
  → LLM: task decomposition specialist 역할
  → LLM: ask_user로 Q&A (한 번에 하나씩)
  → LLM: spec.md + plan.md 생성
  → LLM: ask_user로 유저 승인
  → LLM: swarm_plan_execute(planPath) 호출
    → Server: Phase 1 — dispatch N agents 병렬
    → Server: 완료 대기, plan.md 업데이트
    → Server: return { status: "phase_complete" }
  → LLM: verification checkpoint (ask_user)
  → LLM: swarm_plan_execute(planPath, { resumePhase: 2 }) 호출
    → Server: Phase 2 — dispatch M agents 병렬
    → ...
  → LLM: 최종 결과 요약 제시
```

### Control Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│                    LLM (Gemini)                     │
│                                                     │
│  /swarm:plan "description"                          │
│       │                                             │
│       ▼                                             │
│  Q&A with ask_user (1 question at a time)           │
│       │                                             │
│       ▼                                             │
│  Generate spec.md + plan.md                         │
│       │                                             │
│       ▼                                             │
│  ask_user: "Plan을 승인하시겠습니까?"                │
│       │                                             │
│       ▼                                             │
│  swarm_plan_execute(planPath) ──────────────────┐   │
│       │                                         │   │
│       │    ┌────────────────────────────────┐    │   │
│       │    │        MCP Server              │    │   │
│       │    │                                │    │   │
│       │    │  for each Phase:               │    │   │
│       │    │    mark tasks [~]              │    │   │
│       │    │    dispatch tasks (parallel)   │    │   │
│       │    │    wait for all agents         │    │   │
│       │    │    mark tasks [x] + SHA        │    │   │
│       │    │    return phase_complete       │◄───┘   │
│       │    │                                │        │
│       │    └────────────────────────────────┘        │
│       ▼                                             │
│  Verification checkpoint (ask_user)                 │
│  "Phase N 결과가 기대에 부합하나요?"                 │
│       │                                             │
│       ├─ Yes → resume next phase                    │
│       └─ No  → adjust/abort                         │
│                                                     │
│  (repeat until all phases complete)                 │
│       │                                             │
│       ▼                                             │
│  Final summary                                      │
└─────────────────────────────────────────────────────┘
```

## Components

### 1. `/swarm:plan` Command (New)

**File:** `commands/swarm/plan.toml`

프롬프트 기반 task decomposition specialist. Gemini의 ask_user 도구를 활용하여 유저와 Q&A 세션을 진행하고 spec/plan을 생성합니다.

**프롬프트 핵심 지시사항:**
1. 유저 요청을 분석하고 ask_user로 명확화 질문 (한 번에 하나씩, 가능하면 객관식)
2. 충분한 정보 수집 후 Conductor 표준 형식으로 spec.md 생성
3. Spec 승인 후 Phase > Task 구조로 plan.md 생성
4. Plan 승인 후 `swarm_plan_execute` 호출

### 2. `swarm_plan_execute` MCP Tool (New)

**File:** `src/server.ts` (기존 파일에 추가)

**Parameters:**
```typescript
{
  planPath: string;        // swarm/plans/<plan_id>/plan.md 경로
  resumePhase?: number;    // Phase 재개 지점 (verification checkpoint 후)
  retryTasks?: string[];   // 재시도할 Task 목록 (실패 복구 시)
  skipTasks?: string[];    // 건너뛸 Task 목록 (실패 복구 시)
}
```

**Return Values:**

Phase 완료 시:
```json
{
  "status": "phase_complete",
  "phase": 1,
  "phaseName": "Database Layer",
  "completedTasks": [
    { "task": "Task 1.1", "agent": "agent-1", "duration": 45000 }
  ],
  "nextPhase": { "phase": 2, "name": "API Layer", "taskCount": 3 }
}
```

Task 실패 시:
```json
{
  "status": "phase_failed",
  "phase": 1,
  "phaseName": "Database Layer",
  "completedTasks": ["Task 1.1", "Task 1.3"],
  "failedTasks": [
    { "task": "Task 1.2", "agent": "agent-2", "error": "..." }
  ]
}
```

전체 완료 시:
```json
{
  "status": "plan_complete",
  "totalPhases": 3,
  "totalTasks": 9,
  "duration": 180000
}
```

### 3. Plan Parser Module (New)

**File:** `src/plan-parser.ts`

plan.md 마크다운을 구조화된 데이터로 파싱하고 상태를 업데이트합니다.

```typescript
interface Phase {
  number: number;
  name: string;
  tasks: Task[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

interface Task {
  id: string;          // "1.1", "2.3" etc.
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  sha?: string;        // git commit SHA after completion
  agent?: string;      // assigned agent name
}

interface Plan {
  title: string;
  phases: Phase[];
}

// Core functions
function parsePlan(markdown: string): Plan;
function updateTaskStatus(planPath: string, taskId: string, status: TaskStatus, sha?: string): void;
function getNextPhase(plan: Plan): Phase | null;
function getPendingTasks(phase: Phase): Task[];
```

## Data Structures

### Spec Format (Conductor Standard)

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
- [ ] <criterion>

## Out of Scope
- <excluded item>
```

### Plan Format (Conductor Standard + Parallel Extension)

```markdown
# Plan: <Title>

## Phase 1: <Phase Name>
- [ ] Task 1.1: <description>
- [ ] Task 1.2: <description>

## Phase 2: <Phase Name>
- [ ] Task 2.1: <description>
- [ ] Task 2.2: <description>
```

**상태 마커 (Conductor 표준):**
- `[ ]` — pending
- `[~]` — in-progress
- `[x]` — completed
- `[!]` — failed

**완료 시 SHA 기록:**
```markdown
- [x] Task 1.1: Create users table  <!-- sha: abc1234 -->
```

### Metadata Format

**File:** `swarm/plans/<plan_id>/metadata.json`

```json
{
  "id": "oauth_20260307",
  "description": "Add OAuth to the API",
  "status": "in_progress",
  "currentPhase": 1,
  "createdAt": "2026-03-07T10:00:00Z",
  "updatedAt": "2026-03-07T10:30:00Z",
  "phases": [
    { "name": "Database Layer", "status": "completed", "completedAt": "..." },
    { "name": "API Layer", "status": "pending" }
  ]
}
```

### Directory Structure

```
<project-root>/
└── swarm/
    └── plans/
        └── <plan_id>/
            ├── spec.md         # Requirements specification
            ├── plan.md         # Phased task checklist (living document)
            └── metadata.json   # Execution state
```

`plan_id` 형식: `<shortname>_YYYYMMDD` (Conductor 표준)

## Failure Handling

### Phase 내 Task 실패 시

1. Server가 Phase 실행을 중단
2. 완료된 Task는 `[x]`, 실패한 Task는 `[!]`로 마킹
3. `{ status: "phase_failed", ... }` 반환하여 LLM에 제어권 이전
4. LLM이 ask_user로 유저에게 선택지 제시:
   - **Retry**: `swarm_plan_execute(planPath, { retryTasks: ["1.2"] })`
   - **Skip**: `swarm_plan_execute(planPath, { skipTasks: ["1.2"], resumePhase: 2 })`
   - **Abort**: 실행 중단, 현재 상태 보존

### Verification Checkpoint

Phase 완료마다 LLM이 유저에게 확인:
- "Phase 1 (Database Layer) 완료. 결과를 검토하시겠습니까?"
- 유저 승인 시 다음 Phase 진행
- 유저 거부 시 수정 또는 중단

## Changes Required

| File | Change | Effort |
|------|--------|--------|
| `commands/swarm/plan.toml` | **New** — Plan command prompt | Small |
| `src/plan-parser.ts` | **New** — Plan markdown parser/updater | Medium |
| `src/server.ts` | **Modify** — Add `swarm_plan_execute` tool + handler | Medium |
| `GEMINI.md` | **Modify** — Document new tool and command | Small |

### Not Changed
- `src/tmux-spawner.ts` — 기존 spawn 메커니즘 그대로 활용
- `src/agent-tracker.ts` — 기존 agent tracking 그대로 활용
- `src/message-bus.ts` — 변경 없음
- 기존 `/swarm:dispatch`, `/swarm:status`, `/swarm:results`, `/swarm:kill` — 호환성 유지

## Implementation Notes

### swarm_plan_execute 내부 동작

```typescript
async function handlePlanExecute(args: PlanExecuteArgs) {
  const planContent = readFileSync(args.planPath, 'utf-8');
  const plan = parsePlan(planContent);

  const startPhase = args.resumePhase ?? findNextPendingPhase(plan);
  const phase = plan.phases[startPhase - 1];

  // Determine which tasks to run
  let tasks = getPendingTasks(phase);
  if (args.retryTasks) {
    tasks = tasks.filter(t => args.retryTasks.includes(t.id));
  }
  if (args.skipTasks) {
    for (const id of args.skipTasks) {
      updateTaskStatus(args.planPath, id, 'completed', 'skipped');
    }
    tasks = tasks.filter(t => !args.skipTasks.includes(t.id));
  }

  // Mark tasks in-progress
  for (const task of tasks) {
    updateTaskStatus(args.planPath, task.id, 'in_progress');
  }

  // Dispatch all tasks in parallel (reuse existing handleDispatch logic)
  const agents = await dispatchTasks(tasks, plan);

  // Wait for all agents to complete
  const results = await waitForAllAgents(agents);

  // Update plan.md with results
  for (const result of results) {
    if (result.success) {
      updateTaskStatus(args.planPath, result.taskId, 'completed', result.sha);
    } else {
      updateTaskStatus(args.planPath, result.taskId, 'failed');
    }
  }

  // Check for failures
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    return { status: 'phase_failed', phase: startPhase, ... };
  }

  // Check if more phases remain
  const nextPhase = findNextPendingPhase(parsePlan(readFileSync(args.planPath)));
  if (nextPhase) {
    return { status: 'phase_complete', phase: startPhase, nextPhase, ... };
  }

  return { status: 'plan_complete', ... };
}
```

### Task → Agent Prompt 변환

각 Task는 다음 컨텍스트와 함께 agent에 전달됩니다:
- Task description
- Spec.md 전체 내용 (요구사항 참조)
- Phase 컨텍스트 (이 Task가 속한 Phase의 목적)
- 프로젝트 CWD

```typescript
function buildAgentPrompt(task: Task, spec: string, phase: Phase): string {
  return `You are working on: ${task.description}

## Context
This is part of Phase "${phase.name}".

## Requirements
${spec}

## Instructions
- Complete the task described above
- Follow existing code conventions
- Test your changes if applicable
- Be thorough but focused on this specific task only`;
}
```
