import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LockManager } from '../lock-manager.js';

describe('LockManager', () => {
  const testDir = '/tmp/gemini-swarm-test-locks';
  let lockManager: LockManager;

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
    lockManager = new LockManager(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('acquires and releases a lock', () => {
    const resource = 'test-resource';
    const owner = 'agent-1';

    const acquired = lockManager.acquireLock(resource, owner);
    assert.strictEqual(acquired, true, 'Should acquire lock');
    assert.strictEqual(lockManager.isLocked(resource), true, 'Resource should be locked');

    const released = lockManager.releaseLock(resource, owner);
    assert.strictEqual(released, true, 'Should release lock');
    assert.strictEqual(lockManager.isLocked(resource), false, 'Resource should be unlocked');
  });

  test('cannot acquire lock if already held by another owner', () => {
    const resource = 'shared-resource';
    
    const acquired1 = lockManager.acquireLock(resource, 'agent-1');
    assert.strictEqual(acquired1, true, 'Agent 1 should acquire lock');

    const acquired2 = lockManager.acquireLock(resource, 'agent-2');
    assert.strictEqual(acquired2, false, 'Agent 2 should NOT acquire lock');
  });

  test('can re-acquire lock if same owner', () => {
    const resource = 'reacquire-resource';
    const owner = 'agent-1';

    lockManager.acquireLock(resource, owner);
    const reacquired = lockManager.acquireLock(resource, owner);
    assert.strictEqual(reacquired, true, 'Same owner should be able to re-acquire the lock');
  });

  test('lock expires after TTL', async () => {
    const resource = 'expiring-resource';
    const owner = 'agent-1';
    const ttl = 100; // 100ms

    lockManager.acquireLock(resource, owner, ttl);
    assert.strictEqual(lockManager.isLocked(resource), true, 'Should be locked initially');

    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 150));

    assert.strictEqual(lockManager.isLocked(resource), false, 'Should be unlocked after TTL');
    
    const acquiredAgain = lockManager.acquireLock(resource, 'agent-2');
    assert.strictEqual(acquiredAgain, true, 'Another agent should be able to acquire expired lock');
  });

  test('withLock executes function and releases lock', async () => {
    const resource = 'with-lock-resource';
    const owner = 'agent-1';

    let executed = false;
    const result = await lockManager.withLock(resource, owner, async () => {
      executed = true;
      assert.strictEqual(lockManager.isLocked(resource), true, 'Should be locked during execution');
      return 'success';
    });

    assert.strictEqual(executed, true, 'Function should be executed');
    assert.strictEqual(result, 'success', 'Result should be returned');
    assert.strictEqual(lockManager.isLocked(resource), false, 'Should be unlocked after execution');
  });

  test('withLock returns undefined if lock not acquired', async () => {
    const resource = 'busy-resource';
    lockManager.acquireLock(resource, 'other-agent');

    let executed = false;
    const result = await lockManager.withLock(resource, 'agent-1', async () => {
      executed = true;
      return 'success';
    });

    assert.strictEqual(executed, false, 'Function should NOT be executed');
    assert.strictEqual(result, undefined, 'Result should be undefined');
    assert.strictEqual(lockManager.isLocked(resource), true, 'Should still be locked by other agent');
  });

  test('cannot release lock if not the owner', () => {
    const resource = 'locked-resource';
    lockManager.acquireLock(resource, 'agent-1');

    const released = lockManager.releaseLock(resource, 'agent-2');
    assert.strictEqual(released, false, 'Agent 2 should NOT be able to release Agent 1\'s lock');
    assert.strictEqual(lockManager.isLocked(resource), true, 'Should still be locked');
  });
});
