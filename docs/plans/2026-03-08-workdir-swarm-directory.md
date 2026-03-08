# Working Directory `.swarm/` Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move swarm coordination files from `/tmp/gemini-swarm-{username}` to `{cwd}/.swarm/`, enabling project isolation and multi-swarm concurrency.

**Architecture:** Replace the global `WORK_DIR` constant with a function that reads `SWARM_WORK_DIR` env var (for worktree agents) or defaults to `{cwd}/.swarm`. The orchestrator sets `SWARM_WORK_DIR` when spawning agents so they always point back to the original project's `.swarm/` directory. The coord-server process also receives `SWARM_WORK_DIR` so it writes state to the correct location.

**Tech Stack:** Node.js, TypeScript, node:test

---

### Task 1: Update `types.ts` — change WORK_DIR to use cwd

**Files:**
- Modify: `src/types.ts:115-130`
- Test: `src/tests/work-dir.test.ts`

**Step 1: Write the failing test**

Create `src/tests/work-dir.test.ts`:

```typescript
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

describe('getWorkDir', () => {
  const originalEnv = process.env['SWARM_WORK_DIR'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['SWARM_WORK_DIR'];
    } else {
      process.env['SWARM_WORK_DIR'] = originalEnv;
    }
  });

  it('uses SWARM_WORK_DIR env var when set', async () => {
    process.env['SWARM_WORK_DIR'] = '/custom/path/.swarm';
    // Re-import to pick up env var (dynamic import with cache bust)
    const { getWorkDir } = await import(`../types.js?v=${Date.now()}`);
    assert.strictEqual(getWorkDir(), '/custom/path/.swarm');
  });

  it('defaults to cwd/.swarm when env var is not set', async () => {
    delete process.env['SWARM_WORK_DIR'];
    const { getWorkDir } = await import(`../types.js?v=${Date.now()}`);
    assert.strictEqual(getWorkDir(), `${process.cwd()}/.swarm`);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/tests/work-dir.test.ts`
Expected: FAIL — `getWorkDir` is not exported from types.ts

**Step 3: Write minimal implementation**

In `src/types.ts`, replace the WORK_DIR block (lines 117-130):

```typescript
// ─── Coordination Server ───

export function getWorkDir(): string {
  return process.env['SWARM_WORK_DIR'] ?? path.join(process.cwd(), '.swarm');
}

export const WORK_DIR = getWorkDir();
export const COORD_PORT_FILE = path.join(WORK_DIR, 'server.port');
export const TASKBOARD_FILE = path.join(WORK_DIR, 'taskboard.json');
export const AGENTS_FILE = path.join(WORK_DIR, 'coord-agents.json');
export const INBOX_DIR = path.join(WORK_DIR, 'inbox');
```

Remove the `getUsername` function and `USERNAME` constant (no longer needed).
Remove the `import * as os from 'os';` import (no longer needed).

**Step 4: Run test to verify it passes**

Run: `npx tsx --test src/tests/work-dir.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/tests/work-dir.test.ts
git commit -m "feat: change WORK_DIR from /tmp to cwd/.swarm with SWARM_WORK_DIR override"
```

---

### Task 2: Pass `SWARM_WORK_DIR` to spawned agents in `tmux-spawner.ts`

**Files:**
- Modify: `src/tmux-spawner.ts:90,121-126`
- Test: `src/tests/spawn-flags.test.ts` (extend existing)

**Step 1: Write the failing test**

Add to `src/tests/spawn-flags.test.ts`:

```typescript
it('passes SWARM_WORK_DIR env var to spawned agents', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'tmux-spawner.ts'),
    'utf-8'
  );
  // Tmux spawn path
  assert.match(source, /SWARM_WORK_DIR=/, 'tmux spawn must set SWARM_WORK_DIR');
  // Background spawn path
  assert.match(source, /SWARM_WORK_DIR.*WORK_DIR|WORK_DIR.*SWARM_WORK_DIR/, 'background spawn must pass SWARM_WORK_DIR');
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/tests/spawn-flags.test.ts`
Expected: FAIL — source doesn't contain SWARM_WORK_DIR

**Step 3: Write minimal implementation**

In `src/tmux-spawner.ts`, line 90 — add `SWARM_WORK_DIR` to the tmux command:

```typescript
const tmuxCmd = `SWARM_WORK_DIR=${shellEscape(WORK_DIR)} SWARM_AGENT_NAME=${shellEscape(name)} ${geminiCmd} 2>&1 | tee ${shellEscape(outputFile)}; tmux wait-for -S ${shellEscape(channel)}`;
```

In `spawnBackground` (line 125) — add to env:

```typescript
env: { ...process.env, SWARM_AGENT_NAME: name, SWARM_WORK_DIR: WORK_DIR },
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test src/tests/spawn-flags.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/tmux-spawner.ts src/tests/spawn-flags.test.ts
git commit -m "feat: pass SWARM_WORK_DIR to spawned agents for worktree isolation"
```

---

### Task 3: Pass `SWARM_WORK_DIR` to coord-server process in `coord-client.ts`

**Files:**
- Modify: `src/coord-client.ts:304`

**Step 1: Write the failing test**

Add to `src/tests/spawn-flags.test.ts`:

```typescript
it('passes SWARM_WORK_DIR when spawning coord-server', () => {
  const source = readFileSync(
    join(import.meta.dirname, '..', 'coord-client.ts'),
    'utf-8'
  );
  assert.match(source, /SWARM_WORK_DIR/, 'coord-client must pass SWARM_WORK_DIR to coord-server spawn');
});
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test src/tests/spawn-flags.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

In `src/coord-client.ts`, line 304, pass `SWARM_WORK_DIR` in the env:

```typescript
const proc = spawn(process.execPath, [serverPath], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, SWARM_WORK_DIR: WORK_DIR },
});
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test src/tests/spawn-flags.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/coord-client.ts src/tests/spawn-flags.test.ts
git commit -m "feat: pass SWARM_WORK_DIR to coord-server subprocess"
```

---

### Task 4: Add `.swarm/` to `.gitignore`

**Files:**
- Modify: `.gitignore`

**Step 1: Add the entry**

Append to `.gitignore`:

```
.swarm/
```

**Step 2: Verify**

Run: `git check-ignore .swarm/`
Expected: `.swarm/`

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: add .swarm/ to gitignore"
```

---

### Task 5: Run full test suite and rebuild

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass. Existing tests use constructor injection (e.g., `new LockManager(tmpDir)`, `new MessageBus(tmpDir)`, `new AgentTracker(tmpDir)`), so they should be unaffected.

**Step 2: Rebuild bundles**

Run: `npm run build`
Expected: `dist/server.js` and `dist/coord-server.js` updated.

**Step 3: Commit the build**

```bash
git add dist/server.js dist/coord-server.js
git commit -m "build: rebuild bundles with .swarm/ work directory"
```

---

### Task 6: Clean up old `/tmp` references

**Step 1: Verify no remaining `/tmp` references**

Run: `grep -r "tmpdir\|gemini-swarm-" src/ --include="*.ts"`
Expected: No matches (only test files using `/tmp/` for test isolation, which is fine).

**Step 2: Manual smoke test**

Run: `ls -la .swarm/ 2>/dev/null || echo "clean start"`
Start a swarm session and verify `.swarm/` is created in the working directory with `server.port`, `taskboard.json`, etc.

---

## Summary of changes

| File | Change |
|---|---|
| `src/types.ts` | `WORK_DIR` = `SWARM_WORK_DIR` env var or `cwd/.swarm` |
| `src/tmux-spawner.ts` | Pass `SWARM_WORK_DIR` in both tmux and background spawn |
| `src/coord-client.ts` | Pass `SWARM_WORK_DIR` when spawning coord-server |
| `.gitignore` | Add `.swarm/` |
| `src/tests/work-dir.test.ts` | New test for `getWorkDir()` |
| `src/tests/spawn-flags.test.ts` | Extended with SWARM_WORK_DIR checks |
