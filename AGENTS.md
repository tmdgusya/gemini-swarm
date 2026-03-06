# Gemini Swarm

Gemini CLI 인스턴스를 병렬 tmux pane으로 스폰하여 스웜 모드로 작동하는 오케스트레이터.

## Architecture

Gemini CLI의 MCP 확장으로 동작. `~/.gemini/extensions/gemini-swarm/` → 이 repo의 symlink.

### 파일 구조

| 파일 | 역할 |
|------|------|
| `src/server.ts` | MCP 서버 진입점. 5개 tool handler |
| `src/tmux-spawner.ts` | tmux pane 생성/관리, `wait-for` 시그널링 |
| `src/agent-tracker.ts` | 에이전트 상태 추적 (in-memory + file) |
| `src/message-bus.ts` | JSONL 기반 에이전트 간 메시징 |
| `commands/swarm/*.toml` | `/swarm:dispatch` 등 슬래시 커맨드 정의 |
| `gemini-extension.json` | 확장 매니페스트 (MCP 서버 설정) |
| `GEMINI.md` | Gemini에게 주입되는 도구 사용 가이드 |

## Code Style

- TypeScript strict mode, ES modules (`import/export`)
- `node:` prefix for Node.js built-ins (`node:child_process`, `node:fs`)
- Shell 명령 인자는 반드시 `shellEscape()` 처리
- 에러 무시 시 `catch { /* ignore */ }` 패턴 사용

## Workflow

```bash
# 빌드 (소스 수정 후 반드시 실행)
npm run build

# Type check only
npx tsc --noEmit

# 빌드 후 gemini 재시작하면 새 코드 반영
```

Gemini는 `dist/server.js`를 실행한다. **소스 수정 후 `npm run build` 필수**.

## Key Design Decisions

### tmux wait-for 시그널링 (tail -f 대신)

에이전트 완료 감지에 `tmux wait-for` 채널을 사용한다:

```
[tmux pane]  gemini ... | tee output.jsonl; tmux wait-for -S swarm-agent-1-done
[Node.js]    spawn('tmux', ['wait-for', 'swarm-agent-1-done']).on('close', ...)
```

**왜 tail -f가 아닌가:**
- `tail -f`는 자연 종료가 불가능 → 에이전트 상태가 영구 `running`
- `tmux wait-for`는 gemini 종료 시점에 정확히 close 이벤트 발생
- `;` 체이닝으로 gemini 크래시 시에도 시그널 발송 보장

**pane kill 시 수동 시그널:**
pane을 외부에서 kill하면 shell이 `wait-for -S`를 실행 못 함. 따라서 `kill()`/`killAll()` 메서드에서 수동으로 `tmux wait-for -S` 실행하여 waiter 프로세스 해제.

### isError: true로 LLM 폴링 루프 방지

Gemini LLM이 `swarm_status`/`swarm_results`를 반복 호출하면 CLI의 루프 감지에 걸린다. 대응:

1. **Tool description에 워크플로우 명시** — "dispatch 후 STOP, 사용자가 물어볼 때만 호출"
2. **"still running" 응답에 `isError: true`** — LLM이 에러 응답을 재시도하는 경향이 낮음
3. **텍스트 가이던스만으로는 불충분** — LLM이 무시할 수 있어 구조적 방법 병행

### 출력 파일 경로 관리

`TmuxSpawner.outputPath(name)` 정적 메서드로 경로를 중앙 관리:
- tmux-spawner.ts가 파일 생성
- server.ts의 monitorAgent가 파일 읽기
- handleKill이 파일 정리

경로를 직접 구성하지 말 것. 반드시 `TmuxSpawner.outputPath()` 사용.

### Background (non-tmux) 폴백

tmux가 없으면 `spawnBackground()`로 일반 child process 실행. 이 경우:
- stdout을 직접 수집 (파일이 아닌 pipe)
- `monitorAgent()`의 `useTmux` 파라미터로 분기

## Common Gotchas

- Gemini headless 모드에서 `-y` 없으면 모든 write/shell 도구가 DENY됨
- `stream-json` 출력의 각 줄이 독립 JSON 객체 (NDJSON)
- `tee`를 쓰면 pane에서 실시간 출력 확인 가능. redirect만 쓰면 빈 화면
- `execSync`는 블로킹 — 대량 에이전트 spawn/kill 시 순차 실행됨
- paneMap은 자연 완료 시 `removePaneEntry()`로 정리됨. 미정리 시 `listPanes()`에 stale 엔트리 누적
