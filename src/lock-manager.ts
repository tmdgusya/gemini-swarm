import { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WORK_DIR } from './types.js';

export interface LockInfo {
  owner: string;
  timestamp: string;
  expiresAt?: string;
}

export class LockManager {
  private lockDir: string;

  constructor(lockDir: string = join(WORK_DIR, 'locks')) {
    this.lockDir = lockDir;
    mkdirSync(this.lockDir, { recursive: true });
  }

  /**
   * Tries to acquire a lock for a given resource.
   * @param resourceId A unique identifier for the resource (e.g., a file path).
   * @param owner The name of the agent or process requesting the lock.
   * @param ttlMs Optional Time To Live in milliseconds. If provided, the lock will expire after this time.
   * @returns true if the lock was acquired, false otherwise.
   */
  acquireLock(resourceId: string, owner: string, ttlMs?: number): boolean {
    const lockFilePath = this.getLockFilePath(resourceId);

    try {
      const lockInfo: LockInfo = {
        owner,
        timestamp: new Date().toISOString(),
      };

      if (ttlMs) {
        lockInfo.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      }

      // 'wx' flag: Open for writing. The file is created (if it does not exist) or fails (if it exists).
      writeFileSync(lockFilePath, JSON.stringify(lockInfo), { flag: 'wx' });
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        throw err;
      }

      // Lock already exists, check if it's the same owner or if it's stale
      try {
        const data = readFileSync(lockFilePath, 'utf-8');
        const existingInfo: LockInfo = JSON.parse(data);

        // Re-entrancy: If the same owner already holds the lock, update it
        if (existingInfo.owner === owner) {
          const updatedInfo: LockInfo = {
            ...existingInfo,
            timestamp: new Date().toISOString(),
            expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : undefined,
          };
          writeFileSync(lockFilePath, JSON.stringify(updatedInfo));
          return true;
        }

        // Check for staleness
        if (existingInfo.expiresAt && new Date() > new Date(existingInfo.expiresAt)) {
          // Lock is stale, try to remove it and acquire again
          try {
            unlinkSync(lockFilePath);
          } catch (unlinkErr) {
            // Ignore if already deleted by another process
          }
          
          // One recursive call to try acquiring it now that we've cleared the stale lock
          // We don't want deep recursion, so we only do this once.
          return this.acquireOneTime(lockFilePath, owner, ttlMs);
        }

        return false;
      } catch (readErr) {
        // If we can't read it (e.g., it was just deleted), try to acquire one last time
        return this.acquireOneTime(lockFilePath, owner, ttlMs);
      }
    }
  }

  /**
   * Internal helper for a single retry attempt.
   */
  private acquireOneTime(lockFilePath: string, owner: string, ttlMs?: number): boolean {
    try {
      const lockInfo: LockInfo = {
        owner,
        timestamp: new Date().toISOString(),
      };
      if (ttlMs) {
        lockInfo.expiresAt = new Date(Date.now() + ttlMs).toISOString();
      }
      writeFileSync(lockFilePath, JSON.stringify(lockInfo), { flag: 'wx' });
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Releases a lock if it's owned by the specified owner.
   * @param resourceId The unique identifier for the resource.
   * @param owner The name of the agent or process that owns the lock.
   * @returns true if the lock was released, false if it wasn't owned by the caller.
   */
  releaseLock(resourceId: string, owner: string): boolean {
    const lockFilePath = this.getLockFilePath(resourceId);
    try {
      const data = readFileSync(lockFilePath, 'utf-8');
      const lockInfo: LockInfo = JSON.parse(data);
      if (lockInfo.owner !== owner) return false;
      unlinkSync(lockFilePath);
      return true;
    } catch (err: any) {
      if (err.code === 'ENOENT') return true; // already gone
      console.error(`[lock-manager] Failed to release lock ${resourceId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Checks if a resource is currently locked.
   * @param resourceId The unique identifier for the resource.
   */
  isLocked(resourceId: string): boolean {
    const lockFilePath = this.getLockFilePath(resourceId);
    if (!existsSync(lockFilePath)) {
      return false;
    }

    try {
      const data = readFileSync(lockFilePath, 'utf-8');
      const lockInfo: LockInfo = JSON.parse(data);
      if (lockInfo.expiresAt) {
        return new Date() <= new Date(lockInfo.expiresAt);
      }
      return true;
    } catch (err) {
      return false; // If we can't read it, assume it's gone or invalid
    }
  }

  /**
   * Executes a function while holding a lock.
   * @param resourceId The unique identifier for the resource.
   * @param owner The name of the agent or process requesting the lock.
   * @param fn The function to execute.
   * @param ttlMs Optional TTL for the lock.
   * @returns The result of the function if lock was acquired, or undefined otherwise.
   */
  async withLock<T>(resourceId: string, owner: string, fn: () => Promise<T>, ttlMs?: number): Promise<T | undefined> {
    const acquired = this.acquireLock(resourceId, owner, ttlMs);
    if (!acquired) {
      return undefined;
    }

    try {
      return await fn();
    } finally {
      this.releaseLock(resourceId, owner);
    }
  }

  private getLockFilePath(resourceId: string): string {
    const hash = createHash('sha256').update(resourceId).digest('hex');
    return join(this.lockDir, `${hash}.lock`);
  }
}
