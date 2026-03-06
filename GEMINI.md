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
