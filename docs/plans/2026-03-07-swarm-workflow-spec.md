# Spec: Gemini Swarm Workflow Flowchart

## Overview
Generate a comprehensive Mermaid flowchart that illustrates the Gemini Swarm architecture and its two primary agent workflows: `swarm_dispatch` (quick parallel) and `swarm_plan_execute` (structured phases). The diagram will bridge high-level user interactions with the technical implementation details found in the `src/` directory.

## Functional Requirements
- FR1: Visualize the **User -> Orchestrator (MCP Server)** interaction layer.
- FR2: Detail the **`swarm_dispatch`** workflow (Parallel agent spawning).
- FR3: Detail the **`swarm_plan_execute`** workflow (Phase-based tasking).
- FR4: Show technical components: `TmuxSpawner` (`tmux-spawner.ts`), `AgentTracker` (`agent-tracker.ts`), `MessageBus` (`message-bus.ts`), `LockManager` (`lock-manager.ts`), and `PlanParser` (`plan-parser.ts`).
- FR5: Illustrate the **Communication loop** (Heartbeats, Results collection via file/output parsing).
- FR6: Use Mermaid syntax (`flowchart TD` or `graph LR`).

## Non-Functional Requirements
- NFR1: Clarity: Use subgraphs to group logical components.
- NFR2: Accuracy: Reflect the current implementation in `src/server.ts`.
- NFR3: Readability: Avoid excessive crossing lines; use clear labels for transitions.

## Acceptance Criteria
- [ ] A valid Mermaid code block that renders a flowchart.
- [ ] High-level tool calls (`swarm_dispatch`, `swarm_plan_execute`) are clearly represented as entry points.
- [ ] Technical files/classes are explicitly mentioned in the flow.
- [ ] The lifecycle of an agent (Spawn -> Run -> Monitor -> Resolve -> Result) is shown.
- [ ] The difference between `swarm_dispatch` (manual status check) and `swarm_plan_execute` (automatic waiting/updates) is clear.

## Out of Scope
- Detailed internal logic of `agent-tracker.ts` or `plan-parser.ts`.
- Multi-server or network-based communication (current focus is local tmux/processes).
- Installation or setup steps.
