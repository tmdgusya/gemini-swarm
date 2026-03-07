# Gemini Swarm

A Gemini CLI extension that orchestrates multiple Gemini agents as an autonomous team. Agents claim tasks from a shared TaskBoard, execute them in parallel, and report results — inspired by Claude Code's Agent Teams.

## Prerequisites

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and configured
- **tmux** (recommended) — agents spawn as visible tmux panes
- **Node.js** >= 18

> Without tmux, agents fall back to background processes (no visual panes).

## Installation

```bash
gemini extensions install https://github.com/tmdgusya/gemini-swarm
```

No build step required — bundled with all dependencies.

To verify:

```bash
gemini --list-extensions
# Should show: gemini-swarm
```

## Quick Start

### 1. Start tmux and Gemini

```bash
tmux
gemini
```

### 2. Create tasks and spawn agents

```
> Initialize the swarm, create 3 tasks for analyzing auth.ts, db.ts, and api.ts,
  then spawn 3 agents to work on them.
```

Or step by step:

```
> swarm_init
> swarm_create_tasks with tasks for each module analysis
> swarm_spawn 3 agents
> swarm_status
> swarm_results
```

### 3. Plan-based execution (recommended for complex tasks)

```
> /swarm:plan Implement OAuth2 authentication with refresh tokens
```

This starts an interactive Q&A to generate a spec and phased plan, then executes each phase with parallel agents and verification checkpoints.

## How It Works

```
Orchestrator                    Coordination Server (HTTP)
  │                                     │
  ├─ swarm_init ──────────────────────► Start server
  ├─ swarm_create_tasks ──────────────► TaskBoard: [task1, task2, task3]
  ├─ swarm_spawn(3) ──────────────────► Spawn 3 Gemini CLI agents
  │                                     │
  │   ┌─── Agent 1 ◄───── task_list ────┤
  │   │    claim("1") ─────────────────►│ task1: open → claimed
  │   │    (working...)                 │
  │   │    complete("1", result) ──────►│ task1: claimed → completed
  │   │    task_list ──────────────────►│ no more tasks → exit
  │   │                                │
  │   ├─── Agent 2 ◄───── claim("2") ──┤ ...
  │   └─── Agent 3 ◄───── claim("3") ──┤ ...
  │                                     │
  ├─ swarm_status ────────────────────► Summary of agents + tasks
  └─ swarm_results ───────────────────► Completed task results
```

Agents autonomously pull tasks from the TaskBoard (not pushed by the orchestrator). If there are more tasks than agents, agents pick up remaining tasks after completing their first one.

## MCP Tools

### Orchestrator Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `swarm_init` | — | Start coordination server |
| `swarm_create_tasks` | `tasks[]` | Create tasks on the TaskBoard |
| `swarm_spawn` | `count`, `role?` | Spawn N agent processes |
| `swarm_status` | — | Get agent and task status |
| `swarm_results` | `task_id?` | Collect completed results |
| `swarm_kill` | `agent?` | Kill specific or all agents |
| `swarm_plan_execute` | `planDir`, `resumePhase?` | Execute plan phase-by-phase |

### Agent Tools (used by spawned agents)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `swarm_task_list` | — | List open tasks |
| `swarm_task_claim` | `task_id` | Atomically claim a task |
| `swarm_task_complete` | `task_id`, `result`, `sha?` | Report task completion |
| `swarm_task_fail` | `task_id`, `error` | Report task failure |

### Shared Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `swarm_send` | `to`, `message` | Send message to another agent |
| `swarm_receive` | — | Check message inbox |
| `swarm_lock` / `swarm_unlock` | `resource` | File-level locking |
| `swarm_heartbeat` | — | Agent alive signal |

## Architecture

```
~/.gemini/extensions/gemini-swarm/
├── gemini-extension.json      # Extension manifest
├── GEMINI.md                  # Context for Gemini (orchestrator + agent guide)
├── commands/swarm/            # Slash commands
│   ├── plan.toml
│   ├── status.toml
│   ├── results.toml
│   └── kill.toml
├── src/                       # TypeScript source
│   ├── server.ts              # MCP server (thin client → coord server)
│   ├── coord-server.ts        # HTTP coordination server (TaskBoard, agents, messages, locks)
│   ├── coord-client.ts        # HTTP client + auto-start
│   ├── types.ts               # Shared types and API contract
│   ├── tmux-spawner.ts        # tmux pane lifecycle
│   ├── plan-parser.ts         # Plan.md parser
│   └── lock-manager.ts        # File-based locking
└── dist/                      # Bundled JS (esbuild, zero-install)
    ├── server.js              # MCP entry point
    └── coord-server.js        # Coordination server
```

### Key Design Decisions

- **Pull model**: Agents claim tasks from a shared TaskBoard, not assigned by the orchestrator
- **HTTP coordination**: All agents connect to the same localhost HTTP server for shared state
- **Auto-start**: The coordination server starts automatically on first tool call
- **Heartbeat + auto-release**: Dead agents' tasks are released back to the TaskBoard after 60s
- **Phase-gating**: Plan execution pauses between phases for verification checkpoints

## Troubleshooting

**Agents run as background processes (no tmux panes)**
- Start `tmux` before launching `gemini`

**Extension not loading**
- Verify: `gemini --list-extensions`
- Reinstall: `gemini extensions install https://github.com/tmdgusya/gemini-swarm`

**Agents not picking up tasks**
- Check coordination server: `swarm_status`
- Verify tasks exist: `swarm_task_list`

## Development

```bash
npm install
npm run build        # Bundle with esbuild
npm run build:tsc    # Type-check only
npm test             # Run tests
```

## License

MIT
