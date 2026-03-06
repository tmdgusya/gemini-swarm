# Gemini CLI Hooks System - LifeCycle 분석

## 아키텍처 개요

Gemini CLI의 훅 시스템은 5개의 핵심 컴포넌트로 구성됩니다:

```
HookSystem (총괄 코디네이터)
  ├── HookRegistry     — 설정 파일에서 훅 로드/검증/관리
  ├── HookPlanner      — matcher 기반 훅 선택 + 실행 계획 수립
  ├── HookRunner       — command/runtime 훅 실제 실행 (child_process.spawn)
  ├── HookAggregator   — 복수 훅 결과 병합 (OR/Replace/Union 전략)
  └── HookEventHandler — 이벤트 발행 + 실행 흐름 조율
```

## LifeCycle 훅 이벤트 (실행 순서)

Gemini CLI의 한 세션은 다음 순서로 훅이 발화됩니다:

```
┌─ SessionStart ─────────────────────────────────────────┐
│  source: "startup" | "resume" | "clear"                │
│                                                        │
│  ┌─ BeforeAgent ─────────────────────────────────────┐ │
│  │  (사용자 프롬프트 진입 전)                           │ │
│  │                                                    │ │
│  │  ┌─ BeforeModel ────────────────────────────────┐  │ │
│  │  │  (LLM API 호출 직전, 요청 수정/차단 가능)      │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  │  ┌─ AfterModel ─────────────────────────────────┐  │ │
│  │  │  (LLM 응답 수신 직후, 응답 수정 가능)          │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  │  ┌─ BeforeToolSelection ────────────────────────┐  │ │
│  │  │  (도구 선택 설정 전, 허용 도구 목록 조정)       │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  │  ┌─ BeforeTool ─────────────────────────────────┐  │ │
│  │  │  (도구 실행 전, 입력 수정/차단 가능)            │  │ │
│  │  │  matcher: tool_name 정규식 매칭                │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  │  ┌─ AfterTool ──────────────────────────────────┐  │ │
│  │  │  (도구 실행 후, 결과 확인/차단 가능)            │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  │  ┌─ Notification ───────────────────────────────┐  │ │
│  │  │  (도구 권한 승인 요청 시)                       │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  │  ┌─ PreCompress ────────────────────────────────┐  │ │
│  │  │  (컨텍스트 압축 전, trigger: manual|auto)      │  │ │
│  │  └──────────────────────────────────────────────┘  │ │
│  │                                                    │ │
│  └─ AfterAgent ──────────────────────────────────────┘ │
│     (에이전트 턴 완료 후, clearContext 가능)              │
│                                                        │
└─ SessionEnd ───────────────────────────────────────────┘
   reason: "exit" | "clear" | "logout" | "prompt_input_exit" | "other"
```

## 훅 타입 2가지

| Type | 실행 방식 | 용도 |
|------|----------|------|
| **command** | `child_process.spawn()` → stdin으로 JSON 전달, stdout에서 JSON 수신 | 외부 스크립트/바이너리 |
| **runtime** | 인프로세스 async 함수 (AbortController 지원) | 프로그래밍 방식 등록 |

## 설정 파일 구조 (`.gemini/settings.json`)

```json
{
  "hooksConfig": {
    "BeforeTool": [
      {
        "matcher": "shell_exec|edit_file",
        "sequential": true,
        "hooks": [
          {
            "type": "command",
            "name": "my-guard",
            "command": "./hooks/guard.sh",
            "timeout": 60000,
            "env": { "STRICT": "true" }
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "name": "on-start", "command": "echo '{}'"}
        ]
      }
    ],
    "disabled": ["hook-name-to-disable"]
  }
}
```

## 훅 입출력 프로토콜

**입력** (stdin JSON): 모든 이벤트에 공통 베이스 필드 + 이벤트별 추가 필드

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "/project/dir",
  "hook_event_name": "BeforeTool",
  "timestamp": "2026-03-07T...",
  "tool_name": "shell_exec",
  "tool_input": { "command": "rm -rf /" }
}
```

**출력** (stdout JSON): 훅의 결정을 표현

```json
{
  "decision": "deny",
  "reason": "Dangerous command blocked",
  "continue": false,
  "stopReason": "Security policy violation"
}
```

**Exit code 규칙**:
- `0` → allow (성공)
- `1` → allow + warning (비차단 에러)
- `2+` → deny/block (차단)

## 이벤트별 입력 필드 상세

| 이벤트 | 추가 입력 필드 |
|--------|---------------|
| **SessionStart** | `source` (startup\|resume\|clear) |
| **SessionEnd** | `reason` (exit\|clear\|logout\|prompt_input_exit\|other) |
| **BeforeAgent** | `prompt` |
| **AfterAgent** | `prompt`, `prompt_response`, `stop_hook_active` |
| **BeforeModel** | `llm_request` |
| **AfterModel** | `llm_request`, `llm_response` |
| **BeforeToolSelection** | `llm_request` |
| **BeforeTool** | `tool_name`, `tool_input`, `mcp_context?`, `original_request_name?` |
| **AfterTool** | `tool_name`, `tool_input`, `tool_response`, `mcp_context?`, `original_request_name?` |
| **Notification** | `notification_type`, `message`, `details` |
| **PreCompress** | `trigger` (manual\|auto) |

## 이벤트별 출력(hookSpecificOutput) 상세

| 이벤트 | hookSpecificOutput 필드 | 설명 |
|--------|------------------------|------|
| **BeforeTool** | `tool_input` | 도구 입력 수정 |
| **BeforeModel** | `llm_request` | LLM 요청 수정 |
| **BeforeModel** | `llm_response` | synthetic 응답 (차단 시 대체 응답) |
| **AfterModel** | `llm_response` | LLM 응답 수정 |
| **BeforeToolSelection** | `toolConfig` | `{ mode: "AUTO"\|"ANY"\|"NONE", allowedFunctionNames: [...] }` |
| **AfterAgent** | `clearContext` | `true` → 컨텍스트 초기화 |
| **공통** | `additionalContext` | 프롬프트에 추가할 텍스트 (sanitize됨) |
| **공통** | `tailToolCallRequest` | 도구 실행 후 추가 도구 호출 요청 |

## 결과 병합 전략 (Aggregation)

복수의 훅이 동일 이벤트에 등록된 경우, 이벤트 유형에 따라 병합 전략이 다릅니다:

| 이벤트 그룹 | 전략 | 설명 |
|------------|------|------|
| BeforeTool, AfterTool, BeforeAgent, AfterAgent, SessionStart | **OR Decision** | 하나라도 block/deny면 전체 차단. 메시지는 concatenate |
| BeforeModel, AfterModel | **Field Replacement** | 후순위 훅이 선순위 훅의 필드를 덮어씀 |
| BeforeToolSelection | **Union** | 모든 훅의 허용 도구 합집합. NONE > ANY > AUTO 우선순위 |
| 기타 | **Simple Merge** | 단순 객체 병합 |

## 실행 전략

- **기본**: 병렬 실행 (Promise.all)
- **`sequential: true`**: 순차 실행. 이전 훅의 output이 다음 훅의 input을 수정
  - BeforeAgent: `additionalContext` → prompt에 append
  - BeforeModel: `llm_request` → 요청 객체 merge
  - BeforeTool: `tool_input` → 도구 입력 merge

## 설정 소스 우선순위 (높은 순)

1. **Runtime** — 프로그래밍 방식으로 등록 (`registerHook()`)
2. **Project** — `.gemini/settings.json` (신뢰 폴더에서만 실행)
3. **User** — `~/.gemini/settings.json`
4. **System** — 시스템 레벨 설정
5. **Extensions** — 설치된 확장의 훅

## 보안 모델

- **미신뢰 폴더 차단**: Project 소스 훅은 `isTrustedFolder()` 검사를 통과해야 실행
- **TrustedHooksManager**: 새로운 프로젝트 훅 발견 시 경고 표시 후 신뢰 등록
- **환경 소독**: `sanitizeEnvironment()`로 민감 환경변수 제거 후 자식 프로세스에 전달
- **셸 인자 이스케이프**: `escapeShellArg()`로 command injection 방지
- **변수 치환**: `$GEMINI_PROJECT_DIR` / `$CLAUDE_PROJECT_DIR` → 프로젝트 경로 (이스케이프됨)
- **타임아웃**: 기본 60초, 초과 시 SIGTERM → 5초 후 SIGKILL

## Matcher (훅 필터링)

```json
{
  "matcher": "shell_exec|edit_file",
  "hooks": [...]
}
```

- **Tool 이벤트** (BeforeTool/AfterTool): `matcher`를 정규식으로 `tool_name`에 매칭
- **Session 이벤트**: `matcher`를 trigger/source에 리터럴 매칭
- **미지정 / `"*"` / `""`**: 모든 대상에 매칭

## Swarm 프로젝트와의 관련성

gemini-swarm에서 이 훅 시스템을 활용할 수 있는 포인트:
- **SessionStart/End**: 에이전트 spawn/cleanup 시점 추적
- **BeforeTool/AfterTool**: 에이전트의 도구 사용 모니터링/제어
- **BeforeAgent/AfterAgent**: 프롬프트 주입/응답 후처리
- **Notification**: 권한 승인 요청을 orchestrator로 전달
