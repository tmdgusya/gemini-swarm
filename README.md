# Gemini Swarm Extension

A Gemini CLI extension that spawns multiple Gemini agents in parallel via tmux panes. Dispatch a swarm of agents from your interactive Gemini session to tackle complex tasks concurrently.

## Prerequisites

- [Gemini CLI](https://github.com/google-gemini/gemini-cli) installed and configured
- **tmux** (recommended) — agents spawn as visible tmux panes
- **Node.js** >= 18

> Without tmux, agents fall back to background processes (no visual panes).

## Installation

The extension is already installed at `~/.gemini/extensions/gemini-swarm/`. Gemini CLI auto-discovers extensions in this directory.

To verify:

```bash
gemini --list-extensions
# Should show: gemini-swarm
```

### Manual Build (if needed)

```bash
cd ~/.gemini/extensions/gemini-swarm
npm install
npm run build
```

## Usage

### 1. Start a tmux session

```bash
tmux
```

### 2. Launch Gemini interactive mode

```bash
gemini
```

### 3. Use slash commands

#### `/swarm:dispatch` — Spawn agents

```
> /swarm:dispatch 5 Analyze each module in this codebase and summarize its purpose

> /swarm:dispatch 3 Review this code for security vulnerabilities

> /swarm:dispatch 2 What are the pros and cons of this architecture?
```

Format: `/swarm:dispatch <count> <prompt>`

- `count` — Number of agents (1-10, default 3)
- `prompt` — Task description for the agents

After dispatching, tmux panes appear with each agent working:

```
┌──────────────┬──────────────┐
│ Main Session │  Agent #1    │
│              │  (working..) │
├──────────────┼──────────────┤
│  Agent #2    │  Agent #3    │
│  (working..) │  (done)      │
└──────────────┴──────────────┘
```

#### `/swarm:status` — Check progress

```
> /swarm:status
```

Shows a table of all agents with their name, role, status, elapsed time, and task.

#### `/swarm:results` — Collect results

```
> /swarm:results
```

Gathers and synthesizes responses from all completed agents.

#### `/swarm:kill` — Stop agents

```
> /swarm:kill          # Kill all agents
> /swarm:kill agent-2  # Kill a specific agent
```

### 4. Direct tool calls

You can also ask Gemini to use the tools directly in natural language:

```
> Spawn 3 agents to analyze the src/ directory

> What's the status of my swarm agents?

> Collect the results from the swarm

> Send a message to agent-1 saying "focus on the API layer"

> Kill all swarm agents
```

## MCP Tools Reference

| Tool | Parameters | Description |
|------|-----------|-------------|
| `swarm_dispatch` | `count`, `prompt`, `role?` | Spawn N agents in tmux panes |
| `swarm_status` | — | Get status of all agents |
| `swarm_results` | `task_id?` | Collect agent results |
| `swarm_send` | `to`, `message` | Send message to an agent |
| `swarm_kill` | `agent?` | Kill specific or all agents |

### Roles

- `generalist` (default) — General-purpose agent
- `researcher` — Research and analysis focused
- `coder` — Code writing and implementation
- `reviewer` — Code review and quality checks

## File Structure

```
~/.gemini/extensions/gemini-swarm/
├── gemini-extension.json     # Extension manifest
├── GEMINI.md                 # Context for Gemini (tool docs)
├── commands/swarm/           # Slash commands
│   ├── dispatch.toml
│   ├── status.toml
│   ├── results.toml
│   └── kill.toml
├── src/                      # TypeScript source
│   ├── server.ts             # MCP server (5 tools)
│   ├── tmux-spawner.ts       # tmux pane lifecycle
│   ├── agent-tracker.ts      # Agent state tracking
│   └── message-bus.ts        # JSONL IPC
└── dist/                     # Compiled JS
```

## How It Works

1. `/swarm:dispatch` → TOML command injects prompt → Gemini calls `swarm_dispatch` MCP tool
2. MCP server runs `tmux new-window` for each agent with `gemini -p "..." -y -o stream-json`
3. Agent stdout is captured via named pipes (FIFO) for NDJSON stream parsing
4. Agent tracker monitors completion and stores results to `/tmp/gemini-swarm/results/`
5. `/swarm:status` and `/swarm:results` query the tracker for live updates

## Troubleshooting

**"No tmux session" / agents run as background processes**
- Make sure you started `tmux` before launching `gemini`

**Extension not loading**
- Verify the extension exists: `ls ~/.gemini/extensions/gemini-swarm/gemini-extension.json`
- Rebuild: `cd ~/.gemini/extensions/gemini-swarm && npm run build`

**Agents not completing**
- Check tmux panes directly: `tmux list-windows`
- Check for errors: `/swarm:status`

## License

MIT
