# Gemini Swarm Extension

You have access to swarm tools that let you dispatch multiple Gemini CLI agents in parallel via tmux panes.

## Available Tools

- **swarm_dispatch(count, prompt, role?)** — Spawn N agents to work on a task in parallel tmux panes
- **swarm_status()** — Check the current status of all running/completed agents
- **swarm_results(task_id?)** — Collect results from completed agents
- **swarm_send(to, message)** — Send a message to a specific agent via JSONL inbox
- **swarm_kill(agent?)** — Kill a specific agent or all agents

## Usage Patterns

### Parallel Research
When asked to analyze multiple modules, files, or topics:
1. Use `swarm_dispatch` with one agent per topic
2. Monitor with `swarm_status`
3. Collect with `swarm_results`

### Parallel Code Tasks
When asked to implement changes across multiple files:
1. Dispatch coder agents with specific file assignments
2. Each agent works in isolation
3. Collect results and review

## Slash Commands
- `/swarm:dispatch <N> <prompt>` — Quick dispatch
- `/swarm:status` — Quick status check
- `/swarm:results` — Collect results
- `/swarm:kill` — Stop all agents

## Notes
- Agents run as `gemini -p "..." -y -o stream-json` in tmux panes
- Results are stored in `/tmp/gemini-swarm/results/`
- Inter-agent messages go to `/tmp/gemini-swarm/inbox/`
- If tmux is not available, agents run as background processes
