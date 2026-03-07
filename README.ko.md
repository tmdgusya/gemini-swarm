# Gemini Swarm

여러 Gemini 에이전트를 자율적인 팀으로 오케스트레이션하는 Gemini CLI 확장입니다. 에이전트들이 공유 TaskBoard에서 작업을 가져가고, 병렬로 실행하고, 결과를 보고합니다. Claude Code의 Agent Teams에서 영감을 받았습니다.

## 사전 요구사항

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) 설치 및 설정 완료
- **tmux** (권장) — 에이전트가 보이는 tmux 패널로 생성됨
- **Node.js** >= 18

> tmux 없이도 동작합니다 (백그라운드 프로세스로 폴백).

## 설치

```bash
gemini extensions install https://github.com/tmdgusya/gemini-swarm
```

빌드 불필요 — 모든 의존성이 번들링되어 있습니다.

확인:

```bash
gemini --list-extensions
# gemini-swarm 이 표시되어야 합니다
```

## 빠른 시작

### 1. tmux와 Gemini 시작

```bash
tmux
gemini
```

### 2. 태스크 생성 및 에이전트 스폰

```
> 스웜 초기화하고, auth.ts, db.ts, api.ts 분석 태스크 3개 만들고,
  에이전트 3개 띄워줘.
```

또는 단계별로:

```
> swarm_init
> swarm_create_tasks로 각 모듈 분석 태스크 생성
> swarm_spawn 3개
> swarm_status
> swarm_results
```

### 3. 플랜 기반 실행 (복잡한 작업에 추천)

```
> /swarm:plan OAuth2 인증 시스템에 리프레시 토큰 구현
```

대화형 Q&A로 스펙과 단계별 플랜을 생성한 후, 각 단계를 병렬 에이전트로 실행하고 검증 체크포인트를 거칩니다.

### 4. 리서치 기반 실행

```
> /swarm:research "React 19 Server Components"
```

대화형 Q&A로 리서치 범위를 설정하고, `researcher` 에이전트들을 띄워 정보를 병렬로 수집하며, 마지막에 모든 결과를 종합하여 `report.md` 리포트를 생성합니다.

## 동작 원리

```
Orchestrator                    Coordination Server (HTTP)
  │                                     │
  ├─ swarm_init ──────────────────────► 서버 시작
  ├─ swarm_create_tasks ──────────────► TaskBoard: [task1, task2, task3]
  ├─ swarm_spawn(3) ──────────────────► Gemini CLI 에이전트 3개 스폰
  │                                     │
  │   ┌─── Agent 1 ◄───── task_list ────┤
  │   │    claim("1") ─────────────────►│ task1: open → claimed
  │   │    (작업 중...)                  │
  │   │    complete("1", result) ──────►│ task1: claimed → completed
  │   │    task_list ──────────────────►│ 남은 태스크 없음 → 종료
  │   │                                │
  │   ├─── Agent 2 ◄───── claim("2") ──┤ ...
  │   └─── Agent 3 ◄───── claim("3") ──┤ ...
  │                                     │
  ├─ swarm_status ────────────────────► 에이전트 + 태스크 요약
  └─ swarm_results ───────────────────► 완료된 태스크 결과
```

에이전트는 TaskBoard에서 자율적으로 태스크를 가져갑니다 (오케스트레이터가 할당하는 게 아님). 태스크가 에이전트보다 많으면, 먼저 끝난 에이전트가 나머지 태스크를 자동으로 가져갑니다.

## MCP 도구

### 오케스트레이터 도구

| 도구 | 파라미터 | 설명 |
|------|---------|------|
| `swarm_init` | — | 코디네이션 서버 시작 |
| `swarm_create_tasks` | `tasks[]` | TaskBoard에 태스크 생성 |
| `swarm_spawn` | `count`, `role?` | 에이전트 N개 스폰 |
| `swarm_status` | — | 에이전트 및 태스크 상태 조회 |
| `swarm_results` | `task_id?` | 완료된 결과 수집 |
| `swarm_kill` | `agent?` | 특정 또는 전체 에이전트 종료 |
| `swarm_plan_execute` | `planDir`, `resumePhase?` | 플랜 단계별 실행 |

### 에이전트 도구 (스폰된 에이전트가 사용)

| 도구 | 파라미터 | 설명 |
|------|---------|------|
| `swarm_task_list` | — | 대기 중인 태스크 목록 |
| `swarm_task_claim` | `task_id` | 태스크 원자적 claim |
| `swarm_task_complete` | `task_id`, `result`, `sha?` | 태스크 완료 보고 |
| `swarm_task_fail` | `task_id`, `error` | 태스크 실패 보고 |

### 공유 도구

| 도구 | 파라미터 | 설명 |
|------|---------|------|
| `swarm_send` | `to`, `message` | 다른 에이전트에게 메시지 전송 |
| `swarm_receive` | — | 수신함 확인 |
| `swarm_lock` / `swarm_unlock` | `resource` | 파일 수준 락 |
| `swarm_heartbeat` | — | 에이전트 생존 신호 |

## 아키텍처

```
~/.gemini/extensions/gemini-swarm/
├── gemini-extension.json      # 확장 매니페스트
├── GEMINI.md                  # Gemini 컨텍스트 (오케스트레이터 + 에이전트 가이드)
├── commands/swarm/            # 슬래시 커맨드
│   ├── plan.toml
│   ├── research.toml
│   ├── status.toml
│   ├── results.toml
│   └── kill.toml
├── src/                       # TypeScript 소스
│   ├── server.ts              # MCP 서버 (thin client → coord server)
│   ├── coord-server.ts        # HTTP 코디네이션 서버 (TaskBoard, agents, messages, locks)
│   ├── coord-client.ts        # HTTP 클라이언트 + 자동 시작
│   ├── types.ts               # 공유 타입 및 API 계약
│   ├── tmux-spawner.ts        # tmux 패널 생명주기
│   ├── plan-parser.ts         # plan.md 파서
│   └── lock-manager.ts        # 파일 기반 락
└── dist/                      # 번들된 JS (esbuild, 빌드 불필요)
    ├── server.js              # MCP 진입점
    └── coord-server.js        # 코디네이션 서버
```

### 핵심 설계

- **Pull 모델**: 에이전트가 공유 TaskBoard에서 자율적으로 태스크를 claim
- **HTTP 코디네이션**: 모든 에이전트가 같은 localhost HTTP 서버에 연결하여 상태 공유
- **자동 시작**: 코디네이션 서버가 첫 도구 호출 시 자동으로 시작됨
- **Heartbeat + 자동 해제**: 60초간 무응답 에이전트의 태스크는 TaskBoard로 자동 반환
- **Phase-gating**: 플랜 실행 시 단계 사이에 검증 체크포인트

## 문제 해결

**에이전트가 백그라운드에서 실행됨 (tmux 패널 없음)**
- `gemini` 실행 전에 `tmux`를 먼저 시작하세요

**확장이 로드되지 않음**
- 확인: `gemini --list-extensions`
- 재설치: `gemini extensions install https://github.com/tmdgusya/gemini-swarm`

**에이전트가 태스크를 안 가져감**
- 코디네이션 서버 확인: `swarm_status`
- 태스크 존재 여부 확인: `swarm_task_list`

## 개발

```bash
npm install
npm run build        # esbuild 번들링
npm run build:tsc    # 타입 체크만
npm test             # 테스트 실행
```

## 라이선스

MIT
