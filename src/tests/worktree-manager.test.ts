import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { WorktreeManager } from "../worktree-manager.js";

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-test-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("WorktreeManager", () => {
  let repoDir: string;
  let manager: WorktreeManager;

  afterEach(() => {
    if (manager) {
      try {
        manager.cleanupAll();
      } catch {
        // best effort cleanup
      }
    }
  });

  it("creates and removes a worktree", () => {
    repoDir = createTempRepo();
    manager = new WorktreeManager(repoDir);

    const wt = manager.create("agent-1");
    assert.equal(wt.name, "agent-1");
    assert.equal(wt.branch, "swarm/agent-1");
    assert.equal(wt.path, join(repoDir, ".worktrees", "agent-1"));
    assert.ok(existsSync(wt.path), "worktree directory should exist");

    // creating again returns cached value
    const wt2 = manager.create("agent-1");
    assert.equal(wt2, wt);

    manager.remove("agent-1");
    assert.equal(manager.get("agent-1"), undefined);
  });

  it("lists active worktrees", () => {
    repoDir = createTempRepo();
    manager = new WorktreeManager(repoDir);

    manager.create("alpha");
    manager.create("beta");

    const list = manager.list();
    assert.equal(list.length, 2);

    const names = list.map((w) => w.name).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
  });

  it("cleanupAll removes everything", () => {
    repoDir = createTempRepo();
    manager = new WorktreeManager(repoDir);

    manager.create("x");
    manager.create("y");

    const worktreesDir = join(repoDir, ".worktrees");
    assert.ok(existsSync(worktreesDir));

    manager.cleanupAll();

    assert.equal(manager.list().length, 0);
    assert.ok(!existsSync(worktreesDir), ".worktrees directory should be removed");
  });
});
