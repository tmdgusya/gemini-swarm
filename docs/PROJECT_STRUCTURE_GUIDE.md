# Gemini Swarm Project Structure Guide

This document provides a comprehensive overview of the Gemini Swarm project architecture and its core components.

## Architecture Overview

Gemini Swarm is a distributed agent coordination framework designed to execute complex, multi-step tasks in parallel. It uses a **Coordination Server** as a central hub, while individual **Swarm Agents** (each an instance of the Gemini CLI) perform the actual work.

```mermaid
graph TD
    Orchestrator[Orchestrator / Gemini CLI] -- MCP --> MCPServer[Gemini Swarm MCP Server]
    MCPServer -- REST --> CoordServer[Coordination Server]
    MCPServer -- tmux --> Agents[Swarm Agents]
    Agents -- REST --> CoordServer
    CoordServer -- Local Files --> Persistence[/tmp/gemini-swarm/*.json]
    Agents -- Inbox --> MessageBus[/tmp/gemini-swarm/inbox/*.jsonl]
```

---

## Core Components

### 1. Coordination Server (`src/coord-server.ts`)
The Coordination Server is the brain of the swarm. It's a lightweight Node.js HTTP server that manages the shared state of the entire system.

- **TaskBoard**: A central registry of tasks with statuses: `open`, `claimed`, `completed`, and `failed`.
- **Agent Registry**: Tracks active agents, their roles, and their last heartbeat.
- **Persistence**: All state is periodically saved to JSON files in `/tmp/gemini-swarm/` (e.g., `taskboard.json`, `coord-agents.json`).
- **Heartbeat Mechanism**: Monitors agent health; if an agent misses heartbeats for 60 seconds, it's marked as "dead," and its claimed tasks are returned to the `open` state.

### 2. Message Bus (`src/message-bus.ts`)
The Message Bus provides a reliable way for agents to communicate.

- **File-based Queues**: Messages for each agent are stored in `/tmp/gemini-swarm/inbox/<agent_name>.jsonl`.
- **Offsets**: Agents track their read offset to ensure they don't miss or re-read messages.
- **ACK System**: Supports basic message acknowledgments for critical communication.

### 3. Lock Management (`src/lock-manager.ts`)
The Lock Manager prevents race conditions when multiple agents try to access the same resource (like a file).

- **SHA-256 Hashing**: Resource IDs are hashed to create unique lock file names in `/tmp/gemini-swarm/locks/`.
- **Atomic Operations**: Uses file system primitives (`flag: 'wx'`) to ensure atomic lock acquisition.
- **TTL (Time To Live)**: Locks can have an expiration time to prevent permanent deadlocks if an agent crashes.

### 4. Coordination Client (`src/coord-client.ts`)
The `CoordClient` is the primary interface for interacting with the Coordination Server.

- **REST Wrapper**: Provides easy-to-use methods for all server endpoints.
- **Auto-Bootstrapping**: The `getOrStartCoordServer` function automatically starts the coordination server if it's not already running, making the system self-healing.

### 5. Tmux Spawner (`src/tmux-spawner.ts`)
The Spawner handles the lifecycle of agent processes.

- **Parallelism**: Uses `tmux` to split the terminal into multiple panes, one for each agent. This allows the user to see agents working in real-time.
- **Wait-for Mechanism**: Uses `tmux wait-for` to synchronize process completion with the orchestrator.
- **Background Mode**: If `tmux` is unavailable, it can fallback to spawning agents as detached background processes.

---

## How Swarm Agents Interact

1. **Registration**: When an agent is spawned, it first registers itself with the Coordination Server.
2. **Task Discovery**: The agent calls `swarm_task_list` to find `open` tasks.
3. **Atomic Claim**: It attempts to claim a task via `swarm_task_claim`. The server ensures only one agent can claim a task.
4. **Heartbeat**: While working, the agent periodically calls `swarm_heartbeat` to signal it is still alive.
5. **Messaging**: Agents can send and receive messages using `swarm_send` and `swarm_receive` to collaborate or share results.
6. **Completion**: Once the task is finished, the agent calls `swarm_task_complete` (or `swarm_task_fail`) to report the result.

---

## Plan Execution Workflow (`plan.md`)

The system supports structured execution of complex plans:

1. **Parsing**: The `plan.md` file is parsed into phases and tasks.
2. **Phase Management**: The orchestrator dispatches tasks phase-by-phase. All tasks in Phase 1 must complete (or be skipped) before Phase 2 begins.
3. **Status Updates**: As tasks progress, the `plan.md` file is automatically updated with markers:
   - `[ ]` Pending
   - `[~]` In Progress
   - `[x]` Completed
   - `[!]` Failed
4. **Resumption**: If a phase fails, the orchestrator can resume execution from that phase, retrying only the failed tasks.
