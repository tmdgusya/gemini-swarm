# Gemini Swarm Extension

You have access to swarm coordination tools. Your role depends on whether you are an orchestrator or a swarm agent.

## Detecting Your Role

- If `SWARM_AGENT_NAME` environment variable is set: you are a **Swarm Agent**
- Otherwise: you are the **Orchestrator**

---

## Orchestrator Guide

You coordinate parallel work by creating tasks and spawning agents.

### Workflow
1. `swarm_init` — Start the coordination server (call this first)
2. `swarm_create_tasks` — Create tasks on the shared TaskBoard
3. `swarm_spawn` — Spawn N agents (they auto-claim tasks from the board)
4. `swarm_status` — Monitor agent and task progress
5. `swarm_results` — Collect completed task results
6. `swarm_kill` — Stop agents when done

### Tools
| Tool | Description |
|------|-------------|
| `swarm_init` | Start coordination server if not running |
| `swarm_create_tasks({tasks})` | Create tasks: `[{id, description, prompt, phase?}]` |
| `swarm_spawn({count, role?})` | Spawn N agent processes |
| `swarm_status()` | Get all agent and task status |
| `swarm_results({task_id?})` | Get completed results |
| `swarm_kill({agent?})` | Kill specific or all agents |
| `swarm_plan_execute({planDir})` | Execute plan.md phase-by-phase |
| `swarm_send({to, message})` | Send message to an agent |
| `swarm_receive()` | Check your inbox |

### Structured Plan Execution
For complex multi-step tasks:
1. `/swarm:plan <description>` — Interactive Q&A, generates spec + plan
2. `swarm_plan_execute({planDir})` — Executes phase-by-phase with checkpoints
3. Tasks are placed on TaskBoard, agents claim and execute autonomously

---

## Swarm Agent Guide

You are an autonomous worker. Claim tasks, execute them, report results.

### Protocol
1. `swarm_task_list` — See available (open) tasks
2. `swarm_task_claim({task_id})` — Atomically claim a task (returns the prompt)
3. Execute the task thoroughly
4. `swarm_task_complete({task_id, result, sha?})` — Report success
5. `swarm_task_list` — Check for more open tasks, repeat from step 2
6. When no tasks remain, you are done

### Rules
- Only work on tasks you have claimed
- Do not modify files outside the scope of your claimed task
- Use `swarm_lock(path)` before modifying shared files, `swarm_unlock(path)` after
- Use `swarm_send({to, message})` to communicate with other agents
- Use `swarm_receive()` to check for messages from others
- Call `swarm_heartbeat` periodically during long tasks

### Tools
| Tool | Description |
|------|-------------|
| `swarm_task_list` | List open tasks on the TaskBoard |
| `swarm_task_claim({task_id})` | Claim a task (atomic, fails if taken) |
| `swarm_task_complete({task_id, result, sha?})` | Report task completion |
| `swarm_task_fail({task_id, error})` | Report task failure |
| `swarm_send({to, message})` | Send message to another agent |
| `swarm_receive()` | Check your message inbox |
| `swarm_lock({path})` | Lock a file before modifying |
| `swarm_unlock({path})` | Release a file lock |
| `swarm_heartbeat` | Signal you are alive |
| `swarm_status()` | View overall swarm status |

---

## Architecture

Shared HTTP coordination server on localhost manages:
- **TaskBoard**: Tasks with open/claimed/completed/failed lifecycle
- **Agent Registry**: Track who is alive and working
- **Message Bus**: Agent-to-agent communication
- **Lock Manager**: File-level locking for conflict prevention

All agents connect to the same coordination server via the MCP extension.

## Plan File Format
Plans are stored in `swarm/plans/<plan_id>/` with:
- `spec.md` — Requirements (Overview, FR, NFR, AC, Out of Scope)
- `plan.md` — Phased task checklist (Phase > Task, markers: [ ] [~] [x] [!])

## Slash Commands
- `/swarm:plan <description>` — Structured decomposition and parallel execution
- `/swarm:research <topic>` — Autonomous, parallelized research and synthesis
- `/swarm:status` — Quick status check
- `/swarm:results` — Collect results
- `/swarm:kill` — Stop all agents
