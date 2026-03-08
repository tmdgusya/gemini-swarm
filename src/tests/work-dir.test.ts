import { describe, it, afterEach } from 'node:test';
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
    const { getWorkDir } = await import(`../types.js?v=${Date.now()}`);
    assert.strictEqual(getWorkDir(), '/custom/path/.swarm');
  });

  it('defaults to cwd/.swarm when env var is not set', async () => {
    delete process.env['SWARM_WORK_DIR'];
    const { getWorkDir } = await import(`../types.js?v=${Date.now()}`);
    assert.strictEqual(getWorkDir(), `${process.cwd()}/.swarm`);
  });

  it('resolves relative SWARM_WORK_DIR to absolute path', async () => {
    process.env['SWARM_WORK_DIR'] = './relative/.swarm';
    const { getWorkDir } = await import(`../types.js?v=${Date.now()}`);
    const result = getWorkDir();
    assert.ok(result.startsWith('/'), `Expected absolute path, got: ${result}`);
    assert.ok(result.endsWith('/relative/.swarm'), `Expected path to end with /relative/.swarm, got: ${result}`);
  });
});
