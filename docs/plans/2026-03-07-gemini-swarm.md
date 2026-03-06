# Gemini CLI Swarm Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Gemini CLI 인스턴스들을 병렬로 스폰하고, 파일 기반 메시징으로 세션 간 통신하여, 팀/스웜 모드로 작동하는 오케스트레이터를 구현한다.

**Architecture:** Node.js 기반 오케스트레이터가 여러 `gemini -p "..." -y -o stream-json` 프로세스를 스폰하고, 각 에이전트는 JSONL 인박스 파일로 메시지를 주고받으며, 공유 태스크 보드(JSON 파일)를 통해 작업을 조율한다. Git worktree로 파일 충돌을 방지하고, GEMINI.md로 에이전트별 역할을 주입한다.

**Tech Stack:** Node.js (TypeScript), Gemini CLI v0.32.1, Git worktrees, JSONL files, NDJSON streaming

---

## 조사 결과 요약

### Gemini CLI 핵심 기능 (v0.32.1)

| 기능 | 상세 |
|------|------|
| **비대화형 모드** | `gemini -p "prompt" -y -o json\|stream-json` |
| **YOLO 모드** | `-y` → 모든 도구 자동 승인 (비대화형 필수) |
| **출력 형식** | `text`, `json` (단일 객체), `stream-json` (NDJSON 이벤트 스트림) |
| **세션 재개** | `--resume latest\|<index>\|<uuid>` (비대화형에서도 동작) |
| **stdin 파이핑** | `echo "context" \| gemini -p "task"` (8MB 제한, `-p`와 결합) |
| **모델 선택** | `-m gemini-2.5-pro\|gemini-3` |
| **GEMINI.md** | CLAUDE.md 동등물, 계층적 로딩, `@import` 지원 |
| **커스텀 에이전트** | `.gemini/agents/*.md` (YAML frontmatter + Markdown) |
| **MCP 서버** | stdio/SSE/HTTP/TCP 트랜스포트 지원 |
| **Extension 시스템** | MCP, 훅, 스킬, 에이전트, 커맨드 제공 가능 |
| **ACP 모드** | `--experimental-acp` 양방향 NDJSON (실험적) |
| **A2A 프로토콜** | 원격 에이전트 통신 (HTTP 인증 지원) |
| **Hook 시스템** | BeforeTool/AfterTool/SessionStart 등 이벤트 인터셉트 |
| **Policy Engine** | TOML 기반 도구별 승인/거부 규칙 |
| **샌드박스** | Docker/Podman/gVisor (Linux), sandbox-exec (macOS) |
| **Exit Codes** | 0=성공, 1=에러, 42=입력에러, 53=턴 제한 초과 |

### 비대화형 모드 핵심 제약사항

- `-y` 없이 비대화형 → 쓰기/셸 도구 모두 **DENY** (ASK_USER→DENY 변환)
- `-y` 사용 시 `ask_user` 도구도 DENY (사용자 없으므로 정상)
- `--sandbox` 없으면 에이전트가 호스트 파일시스템에 직접 접근
- `stream-json` 이벤트 타입: `init`, `message`, `tool_use`, `tool_result`, `result`, `error`

### IPC 패턴 분석 결과

| 패턴 | 장점 | 단점 | 채택 여부 |
|------|------|------|----------|
| **파일시스템 JSONL** | 범용, 디버깅 용이, 영속적 | 폴링 지연 | ✅ 메인 |
| **Git Worktree 격리** | 파일 충돌 방지, 병렬 안전 | 디스크 사용량 | ✅ 보조 |
| **Unix Domain Socket** | 빠름, 양방향 | 구현 복잡 | ❌ |
| **MCP 서버** | 구조화된 프로토콜 | 서버 프로세스 필요 | ❌ (향후 고려) |
| **stdin/stdout 파이핑** | 설정 불필요 | 단방향, 부모-자식만 | ✅ 초기 컨텍스트 주입 |

### 기존 커뮤니티 접근법

1. **Maestro-Gemini** — 12-서브에이전트 Extension, `parallel-dispatch.js`로 병렬 실행
2. **파일시스템-as-상태** — `.gemini/agents/tasks/`에 JSON 태스크, `workspace/`에 결과 기록
3. **Git Worktree 격리** — `parallel-code`, `ccmanager`, `aiswarm` 등 도구 활용
4. **CodeAgentSwarm** — 최대 6개 AI CLI 터미널 병렬 실행

---

## 아키텍처 설계

```
┌─────────────────────────────────────────────────────┐
│                   Orchestrator                       │
│  (Node.js TypeScript - swarm.ts)                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │TaskBoard │  │ AgentMgr │  │  ResultCollector  │  │
│  │(tasks/)  │  │          │  │  (results/)       │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│       │              │                │              │
│       └──────────────┼────────────────┘              │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  MessageBus   │                       │
│              │ (inbox/*.jsonl)│                       │
│              └───────┬───────┘                       │
│                      │                               │
└──────────────────────┼───────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │Agent #1 │   │Agent #2 │   │Agent #3 │  ...N
   │gemini -p│   │gemini -p│   │gemini -p│
   │-y -o    │   │-y -o    │   │-y -o    │
   │stream-  │   │stream-  │   │stream-  │
   │json     │   │json     │   │json     │
   │         │   │         │   │         │
   │worktree/│   │worktree/│   │worktree/│
   │agent-1  │   │agent-2  │   │agent-3  │
   └─────────┘   └─────────┘   └─────────┘
```

### 핵심 컴포넌트

1. **TaskBoard** — `swarm/tasks/*.json` 파일로 태스크 관리 (PENDING/IN_PROGRESS/DONE/FAILED)
2. **MessageBus** — `swarm/inbox/<agent-name>.jsonl` 파일로 에이전트 간 메시지 전달
3. **AgentManager** — `child_process.spawn()`으로 Gemini CLI 프로세스 라이프사이클 관리
4. **ResultCollector** — `swarm/results/<task-id>.json`에 결과 수집 및 집계
5. **WorktreeManager** — Git worktree 생성/정리 (코드 수정 태스크용)

### 통신 프로토콜

```jsonl
// swarm/inbox/agent-researcher-1.jsonl (한 줄 한 메시지)
{"id":"msg-001","from":"orchestrator","to":"agent-researcher-1","type":"task","payload":{"taskId":"task-001","prompt":"Research X","context":"..."}}
{"id":"msg-002","from":"agent-coder-1","to":"agent-researcher-1","type":"info","payload":{"content":"Found relevant pattern in file Y"}}

// swarm/results/task-001.json
{"taskId":"task-001","agent":"agent-researcher-1","status":"completed","result":"...","tokens":{"input":1234,"output":567},"duration_ms":45000}
```

---

## 구현 태스크

### Task 1: 프로젝트 초기화 및 기본 구조

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`

**Step 1: 프로젝트 초기화**

```bash
cd /home/roach/gemini-swarm
npm init -y
npm install typescript @types/node tsx --save-dev
```

**Step 2: TypeScript 설정**

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

**Step 3: 핵심 타입 정의**

```typescript
// src/types.ts
export interface SwarmConfig {
  maxAgents: number;
  workDir: string;          // swarm/ 디렉토리 경로
  useWorktrees: boolean;
  model?: string;
  geminiFlags?: string[];   // 추가 gemini CLI 플래그
  timeout?: number;         // 에이전트당 타임아웃 (ms)
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type AgentRole = 'researcher' | 'coder' | 'reviewer' | 'generalist';
export type MessageType = 'task' | 'result' | 'info' | 'error' | 'heartbeat';

export interface Task {
  id: string;
  prompt: string;
  role: AgentRole;
  status: TaskStatus;
  assignedTo?: string;
  dependsOn?: string[];     // 선행 태스크 ID
  context?: string;         // stdin으로 전달할 추가 컨텍스트
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
}

export interface TaskResult {
  taskId: string;
  agent: string;
  status: 'completed' | 'failed';
  response: string;         // gemini 응답 텍스트
  stats?: GeminiStats;
  error?: string;
  durationMs: number;
}

export interface GeminiStats {
  models: Array<{
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
  }>;
  tools: Array<{
    name: string;
    callCount: number;
  }>;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: string;
}

export interface AgentInfo {
  name: string;
  role: AgentRole;
  pid?: number;
  status: 'idle' | 'running' | 'stopped' | 'error';
  currentTask?: string;
  worktreePath?: string;
}

// stream-json 이벤트 타입
export interface GeminiStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'result' | 'error';
  session_id?: string;
  content?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_output?: string;
  response?: string;
  stats?: GeminiStats;
  error?: string;
}
```

**Step 4: Commit**

```bash
git init
git add package.json tsconfig.json src/types.ts
git commit -m "feat: initialize gemini-swarm project with core types"
```

---

### Task 2: TaskBoard — 파일 기반 태스크 관리

**Files:**
- Create: `src/task-board.ts`
- Create: `src/tests/task-board.test.ts`

**Step 1: 테스트 작성**

```typescript
// src/tests/task-board.test.ts
import { TaskBoard } from '../task-board.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('TaskBoard', () => {
  let dir: string;
  let board: TaskBoard;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-test-'));
    board = new TaskBoard(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates and retrieves a task', () => {
    const task = board.createTask({
      prompt: 'Research Node.js streams',
      role: 'researcher',
    });
    assert.strictEqual(task.status, 'pending');
    assert.strictEqual(task.prompt, 'Research Node.js streams');

    const retrieved = board.getTask(task.id);
    assert.deepStrictEqual(retrieved, task);
  });

  test('claims a pending task', () => {
    const task = board.createTask({ prompt: 'Do X', role: 'generalist' });
    const claimed = board.claimTask(task.id, 'agent-1');
    assert.strictEqual(claimed?.status, 'in_progress');
    assert.strictEqual(claimed?.assignedTo, 'agent-1');
  });

  test('cannot double-claim a task', () => {
    const task = board.createTask({ prompt: 'Do X', role: 'generalist' });
    board.claimTask(task.id, 'agent-1');
    const second = board.claimTask(task.id, 'agent-2');
    assert.strictEqual(second, null);
  });

  test('completes a task with result', () => {
    const task = board.createTask({ prompt: 'Do X', role: 'generalist' });
    board.claimTask(task.id, 'agent-1');
    board.completeTask(task.id, {
      taskId: task.id,
      agent: 'agent-1',
      status: 'completed',
      response: 'Done!',
      durationMs: 1000,
    });
    const completed = board.getTask(task.id);
    assert.strictEqual(completed?.status, 'completed');
    assert.strictEqual(completed?.result?.response, 'Done!');
  });

  test('lists available tasks respecting dependencies', () => {
    const t1 = board.createTask({ prompt: 'First', role: 'generalist' });
    const t2 = board.createTask({
      prompt: 'Second',
      role: 'generalist',
      dependsOn: [t1.id],
    });
    const available = board.getAvailableTasks();
    assert.strictEqual(available.length, 1);
    assert.strictEqual(available[0].id, t1.id);
  });
});
```

**Step 2: 테스트 실패 확인**

```bash
npx tsx --test src/tests/task-board.test.ts
```
Expected: FAIL (모듈 없음)

**Step 3: TaskBoard 구현**

```typescript
// src/task-board.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Task, TaskResult, TaskStatus, AgentRole } from './types.js';

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
    if (!existsSync(this.tasksDir)) {
      mkdirSync(this.tasksDir, { recursive: true });
    }
  }

  createTask(opts: CreateTaskOptions): Task {
    const task: Task = {
      id: `task-${randomUUID().slice(0, 8)}`,
      prompt: opts.prompt,
      role: opts.role,
      status: 'pending',
      dependsOn: opts.dependsOn,
      context: opts.context,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.writeTask(task);
    return task;
  }

  getTask(id: string): Task | null {
    const path = join(this.tasksDir, `${id}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  getAllTasks(): Task[] {
    if (!existsSync(this.tasksDir)) return [];
    return readdirSync(this.tasksDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(this.tasksDir, f), 'utf-8')));
  }

  getAvailableTasks(): Task[] {
    const all = this.getAllTasks();
    return all.filter(t => {
      if (t.status !== 'pending') return false;
      if (!t.dependsOn?.length) return true;
      return t.dependsOn.every(depId => {
        const dep = this.getTask(depId);
        return dep?.status === 'completed';
      });
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

  completeTask(id: string, result: TaskResult): void {
    const task = this.getTask(id);
    if (!task) return;
    task.status = result.status === 'completed' ? 'completed' : 'failed';
    task.result = result;
    task.updatedAt = new Date().toISOString();
    this.writeTask(task);
  }

  private writeTask(task: Task): void {
    writeFileSync(
      join(this.tasksDir, `${task.id}.json`),
      JSON.stringify(task, null, 2)
    );
  }
}
```

**Step 4: 테스트 통과 확인**

```bash
npx tsx --test src/tests/task-board.test.ts
```
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/task-board.ts src/tests/task-board.test.ts
git commit -m "feat: add TaskBoard for file-based task management"
```

---

### Task 3: MessageBus — JSONL 기반 에이전트 간 통신

**Files:**
- Create: `src/message-bus.ts`
- Create: `src/tests/message-bus.test.ts`

**Step 1: 테스트 작성**

```typescript
// src/tests/message-bus.test.ts
import { MessageBus } from '../message-bus.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('MessageBus', () => {
  let dir: string;
  let bus: MessageBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarm-msg-'));
    bus = new MessageBus(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('sends and receives a message', () => {
    bus.send({
      from: 'orchestrator',
      to: 'agent-1',
      type: 'task',
      payload: { prompt: 'Do something' },
    });
    const msgs = bus.receive('agent-1');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].from, 'orchestrator');
    assert.strictEqual(msgs[0].type, 'task');
  });

  test('receive clears read messages', () => {
    bus.send({ from: 'a', to: 'b', type: 'info', payload: {} });
    bus.receive('b');
    const msgs = bus.receive('b');
    assert.strictEqual(msgs.length, 0);
  });

  test('broadcast sends to all agents', () => {
    bus.broadcast('orchestrator', ['agent-1', 'agent-2'], 'info', { msg: 'hello' });
    assert.strictEqual(bus.receive('agent-1').length, 1);
    assert.strictEqual(bus.receive('agent-2').length, 1);
  });
});
```

**Step 2: 테스트 실패 확인**

```bash
npx tsx --test src/tests/message-bus.test.ts
```

**Step 3: MessageBus 구현**

```typescript
// src/message-bus.ts
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { Message, MessageType } from './types.js';

export class MessageBus {
  private inboxDir: string;
  private readOffsets: Map<string, number> = new Map();

  constructor(workDir: string) {
    this.inboxDir = join(workDir, 'inbox');
    if (!existsSync(this.inboxDir)) {
      mkdirSync(this.inboxDir, { recursive: true });
    }
  }

  send(opts: { from: string; to: string; type: MessageType; payload: unknown }): Message {
    const msg: Message = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from: opts.from,
      to: opts.to,
      type: opts.type,
      payload: opts.payload,
      timestamp: new Date().toISOString(),
    };
    const inboxPath = join(this.inboxDir, `${opts.to}.jsonl`);
    appendFileSync(inboxPath, JSON.stringify(msg) + '\n');
    return msg;
  }

  receive(agentName: string): Message[] {
    const inboxPath = join(this.inboxDir, `${agentName}.jsonl`);
    if (!existsSync(inboxPath)) return [];

    const content = readFileSync(inboxPath, 'utf-8');
    const offset = this.readOffsets.get(agentName) ?? 0;
    const lines = content.split('\n').filter(l => l.trim());

    if (offset >= lines.length) return [];

    const newMessages = lines.slice(offset).map(l => JSON.parse(l) as Message);
    this.readOffsets.set(agentName, lines.length);
    return newMessages;
  }

  broadcast(from: string, agents: string[], type: MessageType, payload: unknown): void {
    for (const agent of agents) {
      this.send({ from, to: agent, type, payload });
    }
  }
}
```

**Step 4: 테스트 통과 확인**

```bash
npx tsx --test src/tests/message-bus.test.ts
```

**Step 5: Commit**

```bash
git add src/message-bus.ts src/tests/message-bus.test.ts
git commit -m "feat: add MessageBus for JSONL-based inter-agent communication"
```

---

### Task 4: AgentRunner — Gemini CLI 프로세스 스폰 및 스트림 파싱

**Files:**
- Create: `src/agent-runner.ts`
- Create: `src/tests/agent-runner.test.ts`

**Step 1: 테스트 작성**

```typescript
// src/tests/agent-runner.test.ts
import { AgentRunner } from '../agent-runner.js';
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('AgentRunner', () => {
  test('runs gemini in headless mode and returns result', async () => {
    const runner = new AgentRunner({ model: undefined, timeout: 30_000 });
    const result = await runner.run({
      prompt: 'What is 2+2? Reply with just the number.',
      cwd: process.cwd(),
    });
    assert.strictEqual(result.status, 'completed');
    assert.ok(result.response.includes('4'), `Expected "4" in: ${result.response}`);
  });

  test('handles timeout gracefully', async () => {
    const runner = new AgentRunner({ model: undefined, timeout: 1 }); // 1ms timeout
    const result = await runner.run({
      prompt: 'Write a very long essay',
      cwd: process.cwd(),
    });
    assert.strictEqual(result.status, 'failed');
    assert.ok(result.error?.includes('timeout') || result.error?.includes('Timeout'));
  });
});
```

**Step 2: 테스트 실패 확인**

```bash
npx tsx --test src/tests/agent-runner.test.ts
```

**Step 3: AgentRunner 구현**

```typescript
// src/agent-runner.ts
import { spawn, type ChildProcess } from 'child_process';
import type { GeminiStreamEvent, GeminiStats } from './types.js';

export interface RunnerConfig {
  model?: string;
  timeout: number;
  geminiPath?: string;
  extraFlags?: string[];
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  context?: string;        // stdin으로 전달
  env?: Record<string, string>;
}

export interface RunResult {
  status: 'completed' | 'failed';
  response: string;
  stats?: GeminiStats;
  error?: string;
  durationMs: number;
  events: GeminiStreamEvent[];
}

export class AgentRunner {
  private config: RunnerConfig;

  constructor(config: RunnerConfig) {
    this.config = config;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const args = this.buildArgs(opts.prompt);
    const geminiPath = this.config.geminiPath ?? 'gemini';

    return new Promise<RunResult>((resolve) => {
      const events: GeminiStreamEvent[] = [];
      let stdout = '';
      let stderr = '';

      const child: ChildProcess = spawn(geminiPath, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
        resolve({
          status: 'failed',
          response: stdout,
          error: `Timeout after ${this.config.timeout}ms`,
          durationMs: Date.now() - start,
          events,
        });
      }, this.config.timeout);

      if (opts.context && child.stdin) {
        child.stdin.write(opts.context);
        child.stdin.end();
      } else {
        child.stdin?.end();
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        // stream-json 모드: NDJSON 파싱
        const parsedEvents = this.parseStreamJson(stdout);
        if (parsedEvents.length > 0) {
          events.push(...parsedEvents);
          const resultEvent = parsedEvents.find(e => e.type === 'result');
          const errorEvent = parsedEvents.find(e => e.type === 'error');

          resolve({
            status: errorEvent ? 'failed' : 'completed',
            response: resultEvent?.response ?? '',
            stats: resultEvent?.stats,
            error: errorEvent?.error,
            durationMs,
            events,
          });
          return;
        }

        // json 모드: 단일 JSON 객체
        try {
          const json = JSON.parse(stdout);
          resolve({
            status: json.error ? 'failed' : 'completed',
            response: json.response ?? '',
            stats: json.stats,
            error: json.error,
            durationMs,
            events,
          });
          return;
        } catch {
          // text 모드 또는 파싱 실패
        }

        resolve({
          status: code === 0 ? 'completed' : 'failed',
          response: stdout.trim(),
          error: code !== 0 ? `Exit code ${code}: ${stderr.trim()}` : undefined,
          durationMs,
          events,
        });
      });
    });
  }

  private buildArgs(prompt: string): string[] {
    const args = ['-p', prompt, '-y', '-o', 'stream-json'];
    if (this.config.model) {
      args.push('-m', this.config.model);
    }
    if (this.config.extraFlags) {
      args.push(...this.config.extraFlags);
    }
    return args;
  }

  private parseStreamJson(output: string): GeminiStreamEvent[] {
    const events: GeminiStreamEvent[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 비-JSON 라인 무시 (stderr 혼입 등)
      }
    }
    return events.length > 0 && events[0].type ? events : [];
  }
}
```

**Step 4: 테스트 통과 확인**

```bash
npx tsx --test src/tests/agent-runner.test.ts --timeout 60000
```
Expected: PASS (실제 Gemini CLI 호출, 네트워크 필요)

**Step 5: Commit**

```bash
git add src/agent-runner.ts src/tests/agent-runner.test.ts
git commit -m "feat: add AgentRunner for spawning Gemini CLI processes"
```

---

### Task 5: WorktreeManager — Git Worktree 격리

**Files:**
- Create: `src/worktree-manager.ts`
- Create: `src/tests/worktree-manager.test.ts`

**Step 1: 테스트 작성**

```typescript
// src/tests/worktree-manager.test.ts
import { WorktreeManager } from '../worktree-manager.js';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('WorktreeManager', () => {
  let repoDir: string;
  let mgr: WorktreeManager;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'swarm-wt-'));
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: repoDir,
    });
    mgr = new WorktreeManager(repoDir);
  });

  afterEach(() => {
    mgr.cleanupAll();
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('creates and removes a worktree', () => {
    const wt = mgr.create('agent-1');
    assert.ok(existsSync(wt.path));
    assert.ok(wt.branch.includes('agent-1'));

    mgr.remove('agent-1');
    assert.ok(!existsSync(wt.path));
  });

  test('lists active worktrees', () => {
    mgr.create('agent-1');
    mgr.create('agent-2');
    const list = mgr.list();
    assert.strictEqual(list.length, 2);
  });
});
```

**Step 2: 테스트 실패 확인**

```bash
npx tsx --test src/tests/worktree-manager.test.ts
```

**Step 3: WorktreeManager 구현**

```typescript
// src/worktree-manager.ts
import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

export interface Worktree {
  name: string;
  path: string;
  branch: string;
}

export class WorktreeManager {
  private repoRoot: string;
  private worktreeDir: string;
  private worktrees: Map<string, Worktree> = new Map();

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.worktreeDir = join(repoRoot, '.worktrees');
    if (!existsSync(this.worktreeDir)) {
      mkdirSync(this.worktreeDir, { recursive: true });
    }
  }

  create(agentName: string): Worktree {
    const branch = `swarm/${agentName}`;
    const path = join(this.worktreeDir, agentName);

    if (this.worktrees.has(agentName)) {
      return this.worktrees.get(agentName)!;
    }

    execSync(`git worktree add "${path}" -b "${branch}" HEAD`, {
      cwd: this.repoRoot,
      stdio: 'pipe',
    });

    const wt: Worktree = { name: agentName, path, branch };
    this.worktrees.set(agentName, wt);
    return wt;
  }

  remove(agentName: string): void {
    const wt = this.worktrees.get(agentName);
    if (!wt) return;

    execSync(`git worktree remove "${wt.path}" --force`, {
      cwd: this.repoRoot,
      stdio: 'pipe',
    });

    // 브랜치도 정리
    try {
      execSync(`git branch -D "${wt.branch}"`, {
        cwd: this.repoRoot,
        stdio: 'pipe',
      });
    } catch {
      // 브랜치가 이미 없으면 무시
    }

    this.worktrees.delete(agentName);
  }

  list(): Worktree[] {
    return Array.from(this.worktrees.values());
  }

  get(agentName: string): Worktree | undefined {
    return this.worktrees.get(agentName);
  }

  cleanupAll(): void {
    for (const name of this.worktrees.keys()) {
      this.remove(name);
    }
    if (existsSync(this.worktreeDir)) {
      rmSync(this.worktreeDir, { recursive: true, force: true });
    }
  }
}
```

**Step 4: 테스트 통과 확인**

```bash
npx tsx --test src/tests/worktree-manager.test.ts
```

**Step 5: Commit**

```bash
git add src/worktree-manager.ts src/tests/worktree-manager.test.ts
git commit -m "feat: add WorktreeManager for git worktree isolation"
```

---

### Task 6: SwarmOrchestrator — 핵심 오케스트레이터

**Files:**
- Create: `src/orchestrator.ts`

**Step 1: SwarmOrchestrator 구현**

```typescript
// src/orchestrator.ts
import { TaskBoard, type CreateTaskOptions } from './task-board.js';
import { MessageBus } from './message-bus.js';
import { AgentRunner, type RunResult } from './agent-runner.js';
import { WorktreeManager } from './worktree-manager.js';
import type { SwarmConfig, Task, AgentInfo, AgentRole } from './types.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

export class SwarmOrchestrator {
  private config: SwarmConfig;
  private taskBoard: TaskBoard;
  private messageBus: MessageBus;
  private runner: AgentRunner;
  private worktreeMgr?: WorktreeManager;
  private agents: Map<string, AgentInfo> = new Map();
  private activeRuns: Map<string, Promise<RunResult>> = new Map();
  private resultsDir: string;

  constructor(config: SwarmConfig) {
    this.config = config;
    const workDir = join(config.workDir, 'swarm');
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

    this.taskBoard = new TaskBoard(workDir);
    this.messageBus = new MessageBus(workDir);
    this.resultsDir = join(workDir, 'results');
    if (!existsSync(this.resultsDir)) mkdirSync(this.resultsDir, { recursive: true });

    this.runner = new AgentRunner({
      model: config.model,
      timeout: config.timeout ?? 300_000, // 5분 기본
      extraFlags: config.geminiFlags,
    });

    if (config.useWorktrees) {
      this.worktreeMgr = new WorktreeManager(config.workDir);
    }
  }

  // 태스크 일괄 등록
  addTasks(tasks: CreateTaskOptions[]): Task[] {
    return tasks.map(t => this.taskBoard.createTask(t));
  }

  // 스웜 실행 — 모든 태스크가 완료될 때까지 병렬 실행
  async run(): Promise<Map<string, RunResult>> {
    const results = new Map<string, RunResult>();
    console.log(`[swarm] Starting with max ${this.config.maxAgents} parallel agents`);

    while (true) {
      const allTasks = this.taskBoard.getAllTasks();
      const pending = allTasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
      if (pending.length === 0) break;

      const available = this.taskBoard.getAvailableTasks();
      const runningCount = this.activeRuns.size;
      const slotsAvailable = this.config.maxAgents - runningCount;

      // 사용 가능한 슬롯에 태스크 배정
      const toDispatch = available.slice(0, slotsAvailable);
      for (const task of toDispatch) {
        const agentName = `agent-${task.role}-${task.id.slice(5)}`;
        this.taskBoard.claimTask(task.id, agentName);

        console.log(`[swarm] Dispatching ${task.id} to ${agentName}: ${task.prompt.slice(0, 80)}...`);

        const promise = this.dispatchAgent(agentName, task);
        this.activeRuns.set(task.id, promise);

        // 완료 시 정리
        promise.then(result => {
          this.activeRuns.delete(task.id);
          results.set(task.id, result);
          this.taskBoard.completeTask(task.id, {
            taskId: task.id,
            agent: agentName,
            status: result.status,
            response: result.response,
            stats: result.stats,
            error: result.error,
            durationMs: result.durationMs,
          });

          // 결과 파일 저장
          writeFileSync(
            join(this.resultsDir, `${task.id}.json`),
            JSON.stringify({ taskId: task.id, agent: agentName, ...result }, null, 2)
          );

          console.log(`[swarm] ${task.id} ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`);

          // worktree 정리
          if (this.worktreeMgr) {
            this.worktreeMgr.remove(agentName);
          }
        });
      }

      // 최소 하나의 태스크 완료 대기
      if (this.activeRuns.size > 0) {
        await Promise.race(this.activeRuns.values());
      } else {
        // 사용 가능한 태스크도 없고 실행 중인 것도 없으면 대기
        // (의존성 미해결 상태)
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log(`[swarm] All tasks completed. ${results.size} results collected.`);
    return results;
  }

  private async dispatchAgent(agentName: string, task: Task): Promise<RunResult> {
    // worktree 생성 (코드 수정 태스크용)
    let cwd = this.config.workDir;
    if (this.worktreeMgr && task.role === 'coder') {
      const wt = this.worktreeMgr.create(agentName);
      cwd = wt.path;
    }

    // 에이전트에 의존 태스크 결과를 컨텍스트로 주입
    let context = task.context ?? '';
    if (task.dependsOn?.length) {
      const depResults = task.dependsOn
        .map(id => {
          const resultPath = join(this.resultsDir, `${id}.json`);
          if (existsSync(resultPath)) {
            return readFileSync(resultPath, 'utf-8');
          }
          return null;
        })
        .filter(Boolean);

      if (depResults.length > 0) {
        context += '\n\n## 선행 태스크 결과:\n' + depResults.join('\n---\n');
      }
    }

    // 역할별 시스템 프롬프트 접두사
    const rolePrefix = this.getRolePrefix(task.role);
    const fullPrompt = `${rolePrefix}\n\n${task.prompt}`;

    return this.runner.run({
      prompt: fullPrompt,
      cwd,
      context: context || undefined,
    });
  }

  private getRolePrefix(role: AgentRole): string {
    const prefixes: Record<AgentRole, string> = {
      researcher: 'You are a research agent. Focus on gathering information, reading code, and analyzing patterns. Do NOT modify files.',
      coder: 'You are a coding agent. Implement the requested changes precisely. Write clean, tested code.',
      reviewer: 'You are a code review agent. Review the code for bugs, security issues, and improvements. Do NOT modify files.',
      generalist: 'You are a general-purpose agent. Complete the assigned task efficiently.',
    };
    return prefixes[role];
  }

  // 최종 결과 집계 (모든 결과를 하나의 프롬프트로 합산)
  async aggregate(prompt: string): Promise<RunResult> {
    const allResults = this.taskBoard.getAllTasks()
      .filter(t => t.status === 'completed')
      .map(t => `## ${t.id} (${t.role}): ${t.prompt}\n\n${t.result?.response ?? '(no result)'}`)
      .join('\n\n---\n\n');

    return this.runner.run({
      prompt,
      cwd: this.config.workDir,
      context: allResults,
    });
  }

  cleanup(): void {
    this.worktreeMgr?.cleanupAll();
  }
}
```

**Step 2: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat: add SwarmOrchestrator — core parallel agent dispatcher"
```

---

### Task 7: CLI 엔트리포인트 — `swarm` 명령

**Files:**
- Create: `src/cli.ts`
- Create: `src/swarm-config.ts`

**Step 1: 설정 로더 구현**

```typescript
// src/swarm-config.ts
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SwarmConfig } from './types.js';

const DEFAULT_CONFIG: SwarmConfig = {
  maxAgents: 5,
  workDir: process.cwd(),
  useWorktrees: false,
  timeout: 300_000,   // 5분
};

export function loadConfig(configPath?: string): SwarmConfig {
  const path = configPath ?? join(process.cwd(), 'swarm.json');
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, workDir: process.cwd() };

  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return { ...DEFAULT_CONFIG, ...raw, workDir: raw.workDir ?? process.cwd() };
}
```

**Step 2: CLI 엔트리포인트 구현**

```typescript
// src/cli.ts
import { SwarmOrchestrator } from './orchestrator.js';
import { loadConfig } from './swarm-config.js';
import { readFileSync, existsSync } from 'fs';
import type { CreateTaskOptions } from './task-board.js';
import type { AgentRole } from './types.js';

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    console.log(`
gemini-swarm — Gemini CLI 스웜 모드 오케스트레이터

Usage:
  npx tsx src/cli.ts <tasks.json>              태스크 파일로 스웜 실행
  npx tsx src/cli.ts --prompt "질문" -n 5      단일 프롬프트를 N개 에이전트로 분산
  npx tsx src/cli.ts --fan-out <prompts.json>  프롬프트 목록을 병렬 실행 후 집계

Options:
  --config <path>     swarm.json 설정 파일 경로
  --max-agents <n>    최대 병렬 에이전트 수 (기본: 5)
  --model <model>     Gemini 모델 지정
  --worktrees         Git worktree 격리 사용
  --aggregate "prompt" 결과 집계 프롬프트
    `);
    process.exit(0);
  }

  // 설정 로딩
  const configIdx = args.indexOf('--config');
  const config = loadConfig(configIdx >= 0 ? args[configIdx + 1] : undefined);

  const maxIdx = args.indexOf('--max-agents');
  if (maxIdx >= 0) config.maxAgents = parseInt(args[maxIdx + 1]);

  const modelIdx = args.indexOf('--model');
  if (modelIdx >= 0) config.model = args[modelIdx + 1];

  if (args.includes('--worktrees')) config.useWorktrees = true;

  const orchestrator = new SwarmOrchestrator(config);

  try {
    // 모드 1: 태스크 파일
    const taskFile = args.find(a => a.endsWith('.json') && !a.startsWith('--'));
    if (taskFile && existsSync(taskFile)) {
      const tasks: CreateTaskOptions[] = JSON.parse(readFileSync(taskFile, 'utf-8'));
      orchestrator.addTasks(tasks);
    }

    // 모드 2: fan-out
    const fanOutIdx = args.indexOf('--fan-out');
    if (fanOutIdx >= 0) {
      const promptsFile = args[fanOutIdx + 1];
      const prompts: string[] = JSON.parse(readFileSync(promptsFile, 'utf-8'));
      orchestrator.addTasks(
        prompts.map(p => ({ prompt: p, role: 'researcher' as AgentRole }))
      );
    }

    // 모드 3: 단일 프롬프트 분산
    const promptIdx = args.indexOf('--prompt');
    if (promptIdx >= 0) {
      const prompt = args[promptIdx + 1];
      const nIdx = args.indexOf('-n');
      const n = nIdx >= 0 ? parseInt(args[nIdx + 1]) : 1;
      for (let i = 0; i < n; i++) {
        orchestrator.addTasks([{ prompt, role: 'generalist' as AgentRole }]);
      }
    }

    // 스웜 실행
    const results = await orchestrator.run();

    // 결과 집계
    const aggIdx = args.indexOf('--aggregate');
    if (aggIdx >= 0) {
      console.log('\n[swarm] Aggregating results...');
      const aggResult = await orchestrator.aggregate(args[aggIdx + 1]);
      console.log('\n=== Aggregated Result ===\n');
      console.log(aggResult.response);
    } else {
      // 기본: 모든 결과 출력
      console.log('\n=== Results ===\n');
      for (const [taskId, result] of results) {
        console.log(`--- ${taskId} (${result.status}, ${(result.durationMs / 1000).toFixed(1)}s) ---`);
        console.log(result.response.slice(0, 500));
        console.log();
      }
    }
  } finally {
    orchestrator.cleanup();
  }
}

main().catch(err => {
  console.error('[swarm] Fatal error:', err);
  process.exit(1);
});
```

**Step 3: Commit**

```bash
git add src/cli.ts src/swarm-config.ts
git commit -m "feat: add CLI entry point for gemini-swarm"
```

---

### Task 8: GEMINI.md 에이전트 역할 템플릿

**Files:**
- Create: `templates/GEMINI-researcher.md`
- Create: `templates/GEMINI-coder.md`
- Create: `templates/GEMINI-reviewer.md`

**Step 1: 역할별 GEMINI.md 템플릿 생성**

```markdown
<!-- templates/GEMINI-researcher.md -->
# Research Agent Instructions

You are a **Research Agent** in a swarm team. Your job is to investigate, analyze, and report findings.

## Rules
- **NEVER** modify files — you are read-only
- Focus on thorough investigation and clear reporting
- Include file paths and line numbers in references
- Structure your findings with clear headers
- If you find something relevant for another agent, note it explicitly

## Output Format
Structure your response as:
1. **Summary** — 2-3 sentence overview
2. **Key Findings** — bullet points
3. **Details** — in-depth analysis
4. **Recommendations** — actionable next steps
```

```markdown
<!-- templates/GEMINI-coder.md -->
# Coder Agent Instructions

You are a **Coding Agent** in a swarm team. Your job is to implement code changes.

## Rules
- Write clean, tested, minimal code
- Follow existing code conventions
- Make small, focused changes
- Run tests after changes
- Commit your work with clear messages

## Output Format
1. **Changes Made** — list of files modified
2. **Testing** — test results
3. **Notes** — any concerns or follow-ups
```

```markdown
<!-- templates/GEMINI-reviewer.md -->
# Reviewer Agent Instructions

You are a **Code Review Agent** in a swarm team. Your job is to review code quality.

## Rules
- **NEVER** modify files — you are read-only
- Check for: bugs, security issues, performance, readability
- Rate severity: critical / warning / info
- Include specific file:line references

## Output Format
1. **Summary** — overall assessment (PASS / NEEDS_WORK / FAIL)
2. **Issues** — list with severity, file, line, description
3. **Suggestions** — optional improvements
```

**Step 2: Commit**

```bash
git add templates/
git commit -m "feat: add GEMINI.md role templates for swarm agents"
```

---

### Task 9: 예제 태스크 파일 및 실행 테스트

**Files:**
- Create: `examples/research-tasks.json`
- Create: `examples/fan-out-prompts.json`
- Create: `swarm.json`

**Step 1: 기본 설정 파일**

```json
// swarm.json
{
  "maxAgents": 5,
  "useWorktrees": false,
  "timeout": 300000,
  "model": "gemini-2.5-pro"
}
```

**Step 2: 예제 태스크 파일**

```json
// examples/research-tasks.json
[
  {
    "prompt": "Analyze the project structure of this repository and list all source files with their purposes.",
    "role": "researcher"
  },
  {
    "prompt": "Review the TypeScript types in src/types.ts and suggest any improvements or missing types.",
    "role": "reviewer"
  },
  {
    "prompt": "Write a comprehensive README.md for this project explaining what gemini-swarm does and how to use it.",
    "role": "coder"
  }
]
```

```json
// examples/fan-out-prompts.json
[
  "What are the best practices for Node.js child process management?",
  "What are common patterns for file-based IPC in distributed systems?",
  "How do modern AI agent frameworks handle task dependencies?"
]
```

**Step 3: 통합 테스트 실행**

```bash
# 단일 프롬프트 테스트
npx tsx src/cli.ts --prompt "What is 2+2? Reply briefly." -n 2 --max-agents 2

# 팬아웃 테스트
npx tsx src/cli.ts --fan-out examples/fan-out-prompts.json --max-agents 3

# 태스크 파일 테스트
npx tsx src/cli.ts examples/research-tasks.json --max-agents 3
```

**Step 4: Commit**

```bash
git add swarm.json examples/
git commit -m "feat: add example tasks and default swarm configuration"
```

---

### Task 10: package.json 스크립트 및 bin 설정

**Files:**
- Modify: `package.json`

**Step 1: package.json에 스크립트 추가**

```json
{
  "name": "gemini-swarm",
  "version": "0.1.0",
  "description": "Gemini CLI swarm mode orchestrator — run parallel Gemini agents with file-based IPC",
  "type": "module",
  "bin": {
    "gemini-swarm": "./bin/gemini-swarm.js"
  },
  "scripts": {
    "start": "tsx src/cli.ts",
    "test": "tsx --test src/tests/*.test.ts",
    "build": "tsc",
    "swarm": "tsx src/cli.ts"
  }
}
```

**Step 2: bin 래퍼 생성**

```bash
mkdir -p bin
```

```javascript
// bin/gemini-swarm.js
#!/usr/bin/env node
import('../dist/cli.js');
```

**Step 3: Commit**

```bash
git add package.json bin/
git commit -m "feat: add npm scripts and bin entry point"
```

---

## 고급 기능 (향후 확장)

### 확장 1: GEMINI.md 동적 주입
각 에이전트 worktree에 역할별 `GEMINI.md`를 동적 생성하여 에이전트 행동을 세밀하게 제어.

### 확장 2: stream-json 실시간 모니터링
`stream-json` NDJSON 이벤트를 실시간 파싱하여 에이전트 진행 상황을 대시보드로 표시.

### 확장 3: MCP 서버 기반 통신
오케스트레이터를 MCP 서버로 구현하여 각 Gemini 에이전트가 MCP 도구로 메시지를 주고받도록 전환.

### 확장 4: A2A 프로토콜 활용
`--experimental-acp` 모드를 활용한 양방향 통신으로 더 정교한 에이전트 간 대화 구현.

### 확장 5: 에이전트 간 핸드오프
OpenAI Swarm 스타일의 에이전트 간 태스크 전달 (researcher → coder → reviewer 파이프라인).

---

## 핵심 명령어 요약

```bash
# 기본 스웜 실행
npx tsx src/cli.ts examples/research-tasks.json --max-agents 5

# 팬아웃 + 집계
npx tsx src/cli.ts --fan-out prompts.json --aggregate "Synthesize all findings into a report" --max-agents 10

# 단일 프롬프트 N개 에이전트
npx tsx src/cli.ts --prompt "Analyze this codebase" -n 3

# Worktree 격리 + 코딩 에이전트
npx tsx src/cli.ts tasks.json --worktrees --max-agents 5

# 모델 지정
npx tsx src/cli.ts tasks.json --model gemini-3 --max-agents 10
```

## Gemini CLI 비대화형 호출 패턴 (참고)

```bash
# 기본 비대화형
gemini -p "prompt" -y -o stream-json 2>/dev/null

# stdin 컨텍스트 + 프롬프트
echo "$context" | gemini -p "analyze this" -y -o json

# 세션 재개 (멀티턴)
gemini -p "continue" -y -o json --resume latest

# 모델 지정 + 샌드박스
gemini -p "prompt" -y -o json -m gemini-3 --sandbox
```
