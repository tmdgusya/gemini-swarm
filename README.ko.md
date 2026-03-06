# Gemini Swarm Extension

Gemini CLI 대화형 세션에서 여러 에이전트를 tmux 패널로 병렬 스폰하는 확장입니다. 복잡한 작업을 여러 에이전트가 동시에 처리합니다.

## 사전 요구사항

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) 설치 및 설정 완료
- **tmux** (권장) — 에이전트가 보이는 tmux 패널로 생성됨
- **Node.js** >= 18

> tmux 없이도 동작합니다 (백그라운드 프로세스로 폴백).

## 설치

확장이 `~/.gemini/extensions/gemini-swarm/`에 이미 설치되어 있습니다. Gemini CLI가 이 디렉토리를 자동으로 인식합니다.

확인:

```bash
gemini --list-extensions
# gemini-swarm 이 표시되어야 합니다
```

### 수동 빌드 (필요시)

```bash
cd ~/.gemini/extensions/gemini-swarm
npm install
npm run build
```

## 사용법

### 1. tmux 세션 시작

```bash
tmux
```

### 2. Gemini 대화형 모드 진입

```bash
gemini
```

### 3. 슬래시 커맨드 사용

#### `/swarm:dispatch` — 에이전트 스폰

```
> /swarm:dispatch 5 이 코드베이스의 각 모듈을 분석하고 목적을 요약해줘

> /swarm:dispatch 3 이 코드의 보안 취약점을 검토해줘

> /swarm:dispatch 2 이 아키텍처의 장단점은?
```

형식: `/swarm:dispatch <개수> <프롬프트>`

- `개수` — 에이전트 수 (1-10, 기본값 3)
- `프롬프트` — 에이전트에게 줄 작업 설명

디스패치 후 각 에이전트가 tmux 패널에 나타납니다:

```
┌──────────────┬──────────────┐
│ 메인 세션     │  Agent #1    │
│              │  (작업 중..)  │
├──────────────┼──────────────┤
│  Agent #2    │  Agent #3    │
│  (작업 중..)  │  (완료)      │
└──────────────┴──────────────┘
```

#### `/swarm:status` — 진행 상황 확인

```
> /swarm:status
```

모든 에이전트의 이름, 역할, 상태, 경과 시간, 작업 내용을 테이블로 보여줍니다.

#### `/swarm:results` — 결과 수집

```
> /swarm:results
```

완료된 에이전트들의 응답을 모아서 정리해줍니다.

#### `/swarm:kill` — 에이전트 중지

```
> /swarm:kill          # 모든 에이전트 중지
> /swarm:kill agent-2  # 특정 에이전트만 중지
```

### 4. 자연어로 직접 사용

슬래시 커맨드 없이 자연어로도 도구를 호출할 수 있습니다:

```
> 에이전트 3개 띄워서 src/ 디렉토리 분석해줘

> 스웜 에이전트 상태 어때?

> 스웜 결과 모아줘

> agent-1한테 "API 레이어에 집중해" 라고 메시지 보내줘

> 스웜 에이전트 전부 종료해
```

## MCP 도구 레퍼런스

| 도구 | 파라미터 | 설명 |
|------|---------|------|
| `swarm_dispatch` | `count`, `prompt`, `role?` | N개 에이전트를 tmux 패널로 스폰 |
| `swarm_status` | — | 모든 에이전트 상태 조회 |
| `swarm_results` | `task_id?` | 에이전트 결과 수집 |
| `swarm_send` | `to`, `message` | 특정 에이전트에 메시지 전송 |
| `swarm_kill` | `agent?` | 특정 또는 전체 에이전트 종료 |

### 역할 (Role)

- `generalist` (기본값) — 범용 에이전트
- `researcher` — 조사/분석 특화
- `coder` — 코드 작성/구현 특화
- `reviewer` — 코드 리뷰/품질 검토 특화

## 파일 구조

```
~/.gemini/extensions/gemini-swarm/
├── gemini-extension.json     # 확장 매니페스트
├── GEMINI.md                 # Gemini 컨텍스트 (도구 설명서)
├── commands/swarm/           # 슬래시 커맨드
│   ├── dispatch.toml
│   ├── status.toml
│   ├── results.toml
│   └── kill.toml
├── src/                      # TypeScript 소스
│   ├── server.ts             # MCP 서버 (5개 도구)
│   ├── tmux-spawner.ts       # tmux 패널 생명주기
│   ├── agent-tracker.ts      # 에이전트 상태 추적
│   └── message-bus.ts        # JSONL IPC
└── dist/                     # 컴파일된 JS
```

## 동작 원리

1. `/swarm:dispatch` → TOML 커맨드가 프롬프트 주입 → Gemini가 `swarm_dispatch` MCP 도구 호출
2. MCP 서버가 `tmux new-window`로 각 에이전트 패널 생성, `gemini -p "..." -y -o stream-json` 실행
3. 에이전트 stdout을 named pipe(FIFO)로 캡처하여 NDJSON 스트림 파싱
4. 에이전트 트래커가 완료를 감지하고 결과를 `/tmp/gemini-swarm/results/`에 저장
5. `/swarm:status`와 `/swarm:results`로 실시간 상태/결과 조회

## 문제 해결

**"tmux 세션 없음" / 에이전트가 백그라운드로 실행됨**
- `gemini` 실행 전에 `tmux`를 먼저 시작했는지 확인하세요

**확장이 로드되지 않음**
- 확장 파일 확인: `ls ~/.gemini/extensions/gemini-swarm/gemini-extension.json`
- 재빌드: `cd ~/.gemini/extensions/gemini-swarm && npm run build`

**에이전트가 완료되지 않음**
- tmux 패널 직접 확인: `tmux list-windows`
- 에러 확인: `/swarm:status`

## 라이선스

MIT
