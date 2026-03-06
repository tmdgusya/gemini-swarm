import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Worktree {
  name: string;
  path: string;
  branch: string;
}

export class WorktreeManager {
  private repoRoot: string;
  private worktreesDir: string;
  private worktrees: Map<string, Worktree> = new Map();

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.worktreesDir = join(repoRoot, ".worktrees");
    mkdirSync(this.worktreesDir, { recursive: true });
  }

  create(agentName: string): Worktree {
    const existing = this.worktrees.get(agentName);
    if (existing) {
      return existing;
    }

    const wtPath = join(this.worktreesDir, agentName);
    const branch = `swarm/${agentName}`;

    execSync(`git worktree add ${wtPath} -b ${branch} HEAD`, {
      cwd: this.repoRoot,
      stdio: "pipe",
    });

    const worktree: Worktree = {
      name: agentName,
      path: wtPath,
      branch,
    };

    this.worktrees.set(agentName, worktree);
    return worktree;
  }

  remove(agentName: string): void {
    const worktree = this.worktrees.get(agentName);
    if (!worktree) {
      return;
    }

    try {
      execSync(`git worktree remove ${worktree.path} --force`, {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    } catch {
      // ignore errors
    }

    try {
      execSync(`git branch -D swarm/${agentName}`, {
        cwd: this.repoRoot,
        stdio: "pipe",
      });
    } catch {
      // ignore errors
    }

    this.worktrees.delete(agentName);
  }

  list(): Worktree[] {
    return Array.from(this.worktrees.values());
  }

  get(agentName: string): Worktree | undefined {
    return this.worktrees.get(agentName);
  }

  cleanupAll(): void {
    for (const [agentName] of this.worktrees) {
      this.remove(agentName);
    }

    if (existsSync(this.worktreesDir)) {
      rmSync(this.worktreesDir, { recursive: true, force: true });
    }
  }
}
