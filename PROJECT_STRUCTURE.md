# Gemini Swarm Project Structure (프로젝트 구조 가이드)

This document provides a clear and easy-to-understand overview of the `gemini-swarm` project's architecture and directory structure.

이 문서는 `gemini-swarm` 프로젝트의 아키텍처와 디렉토리 구조에 대한 이해하기 쉬운 개요를 제공합니다.

---

## 🏗 High-Level Architecture (상위 아키텍처)

The project follows an **Orchestrator-Agent** model coordinated by a central **Coordination Server**.
이 프로젝트는 중앙 **조정 서버(Coordination Server)**에 의해 조정되는 **오케스트레이터-에이전트(Orchestrator-Agent)** 모델을 따릅니다.

1.  **Orchestrator (Main Session):** The primary Gemini CLI session that initiates tasks, creates plans, and spawns agents.
    (오케스트레이터: 작업을 시작하고, 계획을 세우며, 에이전트를 생성하는 기본 Gemini CLI 세션입니다.)
2.  **Coordination Server:** A lightweight HTTP server that manages the TaskBoard, Agent Registry, Message Bus, and Resource Locking.
    (조정 서버: 작업 보드, 에이전트 등록, 메시지 버스 및 리소스 잠금을 관리하는 경량 HTTP 서버입니다.)
3.  **Swarm Agents:** Independent Gemini CLI processes (running in tmux panes or background) that claim and execute tasks.
    (스웜 에이전트: 작업을 가져와서 실행하는 독립적인 Gemini CLI 프로세스입니다. tmux 창이나 백그라운드에서 실행됩니다.)

---

## 📂 Directory Structure (디렉토리 구조)

### Root Directory
- `package.json`: Project dependencies and scripts (TypeScript, MCP SDK).
- `tsconfig.json`: TypeScript configuration.
- `gemini-extension.json`: Manifest for the Gemini CLI extension.
- `GEMINI.md`: Documentation and instructions for Gemini about available tools.
- `AGENTS.md`: High-level information about agent behavior.

### `src/` - Source Code (소스 코드)
The core logic resides here:
- **`server.ts`**: The main entry point. Implements the MCP (Model Context Protocol) server and defines all swarm tools (e.g., `swarm_spawn`, `swarm_task_claim`).
- **`coord-server.ts`**: Implementation of the central Coordination Server (HTTP-based).
- **`coord-client.ts`**: Client helper for communicating with the Coordination Server.
- **`tmux-spawner.ts`**: Logic for spawning new agents using `tmux` windows/panes.
- **`plan-parser.ts`**: Parses Markdown-based execution plans into structured phases and tasks.
- **`lock-manager.ts`**: Manages resource locks to prevent agents from interfering with each other.
- **`message-bus.ts`**: Facilitates communication between agents via the Coordination Server.
- **`agent-tracker.ts`**: (Legacy/Auxiliary) Tracks agent state and results.
- **`types.ts`**: Shared TypeScript interfaces and types.
- **`tests/`**: Unit tests for various components.

### `commands/swarm/` - Slash Commands
Contains TOML files defining the custom `/swarm:*` commands for the Gemini CLI:
- `dispatch.toml`, `plan.toml`, `status.toml`, `results.toml`, `kill.toml`, etc.

### `swarm/plans/` - Execution Plans
Storage for structured plans (spec.md and plan.md) used by `swarm_plan_execute`.

---

## 🛠 Core Components (핵심 구성 요소)

### 1. TaskBoard (작업 보드)
Managed by the Coordination Server. It keeps track of tasks in various states: `open` (waiting), `claimed` (being worked on), `completed`, or `failed`.
(조정 서버에서 관리하며, 작업의 상태(대기 중, 진행 중, 완료, 실패)를 추적합니다.)

### 2. Message Bus (메시지 버스)
Allows agents to send and receive messages (e.g., sharing research findings or status updates) using `swarm_send` and `swarm_receive`.
(에이전트들이 `swarm_send`와 `swarm_receive`를 통해 서로 메시지를 주고받을 수 있게 합니다.)

### 3. Lock Manager (잠금 관리자)
Ensures that only one agent modifies a specific resource (like a file) at a time using `swarm_lock` and `swarm_unlock`.
(한 번에 하나의 에이전트만 특정 리소스를 수정할 수 있도록 보장합니다.)

---

## 🚀 Workflow (워크플로우)

1.  **Init:** Orchestrator calls `swarm_init` to start the Coordination Server.
2.  **Spawn:** Orchestrator calls `swarm_spawn` or `swarm_plan_execute` to create agents.
3.  **Work:** Agents call `swarm_task_list`, claim a task, perform work, and report back with `swarm_task_complete`.
4.  **Collect:** Orchestrator monitors progress via `swarm_status` and collects final results with `swarm_results`.
