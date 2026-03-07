# Plan: Generate Gemini Swarm Workflow Flowchart

## Phase 1: Research and Mapping
- [ ] Task 1.1: Map the detailed agent lifecycle in `src/server.ts` and `src/tmux-spawner.ts`.
- [ ] Task 1.2: Map the `swarm_plan_execute` loop in `src/server.ts` and `src/plan-parser.ts`.
- [x] Task 1.3: Document the `MessageBus` and `InboxWatcher` interaction for heartbeats.

## Phase 2: Mermaid Generation
- [x] Task 2.1: Create a Mermaid flowchart representing the logical components and file-specific roles.
- [ ] Task 2.2: Illustrate the branching workflows: `swarm_dispatch` (quick) vs. `swarm_plan_execute` (structured).
- [ ] Task 2.3: Include technical details like `TmuxSpawner`, `AgentTracker`, and `LockManager`.

## Phase 3: Documentation and Verification
- [ ] Task 3.1: Save the Mermaid flowchart to a Markdown file.
- [ ] Task 3.2: Verify the flowchart's accuracy against the current implementation.
