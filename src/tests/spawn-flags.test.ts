import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Valid Gemini CLI flags (from gemini --help, v0.32.1)
const VALID_GEMINI_FLAGS = new Set([
  '-p', '--prompt',
  '-y', '--yolo',
  '-o', '--output-format',
  '-m', '--model',
  '-s', '--sandbox',
  '--resume',
  '--approval-mode',
  '--include-directories',
  '--policy',
  '--experimental-acp',
  '-h', '--help',
  '-v', '--version',
  '--debug',
  '--verbosity',
]);

describe('Gemini CLI flag validation', () => {
  const serverPath = join(import.meta.dirname, '../server.ts');
  const serverSource = readFileSync(serverPath, 'utf-8');

  test('server.ts does not pass invalid flags to gemini CLI via extraFlags', () => {
    // Find all extraFlags arrays in the source
    const extraFlagsRegex = /extraFlags:\s*\[([^\]]*)\]/g;
    let match;
    const invalidFlags: string[] = [];

    while ((match = extraFlagsRegex.exec(serverSource)) !== null) {
      const content = match[1];
      // Extract flag names from the array content
      const flagMatches = content.matchAll(/[`'"](-{1,2}[a-zA-Z][\w-]*)/g);
      for (const fm of flagMatches) {
        const flag = fm[1].split('=')[0];
        if (!VALID_GEMINI_FLAGS.has(flag)) {
          invalidFlags.push(flag);
        }
      }
    }

    assert.strictEqual(
      invalidFlags.length, 0,
      `server.ts passes invalid Gemini CLI flags via extraFlags: [${invalidFlags.join(', ')}]. ` +
      `Valid flags: ${[...VALID_GEMINI_FLAGS].join(', ')}. ` +
      `Environment variables should be set via TmuxSpawner (env option or tmux command prefix), not via CLI flags.`
    );
  });

  test('server.ts does not contain --set-env flag (not a valid gemini flag)', () => {
    assert.ok(
      !serverSource.includes('--set-env'),
      'server.ts contains "--set-env" which is not a valid Gemini CLI flag. ' +
      'Use SWARM_AGENT_NAME env var via TmuxSpawner instead (already set in spawnInTmux and spawnBackground).'
    );
  });

  test('tmux-spawner.ts sets SWARM_AGENT_NAME in both tmux and background modes', () => {
    const spawnerPath = join(import.meta.dirname, '../tmux-spawner.ts');
    const spawnerSource = readFileSync(spawnerPath, 'utf-8');

    // Check tmux mode sets env var in the command
    assert.ok(
      spawnerSource.includes('SWARM_AGENT_NAME='),
      'tmux-spawner.ts must set SWARM_AGENT_NAME in the tmux command string for tmux mode'
    );

    // Check background mode sets env var via spawn options
    assert.ok(
      spawnerSource.includes("SWARM_AGENT_NAME: name"),
      'tmux-spawner.ts must pass SWARM_AGENT_NAME in the env option for background mode'
    );
  });

  test('passes SWARM_WORK_DIR env var to spawned agents', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'tmux-spawner.ts'),
      'utf-8'
    );
    assert.match(source, /SWARM_WORK_DIR=/, 'tmux spawn must set SWARM_WORK_DIR');
  });

  test('passes SWARM_WORK_DIR when spawning coord-server', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'coord-client.ts'),
      'utf-8'
    );
    assert.match(source, /SWARM_WORK_DIR/, 'coord-client must pass SWARM_WORK_DIR to coord-server spawn');
  });
});
