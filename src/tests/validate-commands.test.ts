import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseTOML } from 'smol-toml';

const COMMANDS_DIR = join(import.meta.dirname, '../../commands');

/** Recursively collect all .toml files under a directory */
function collectTomlFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectTomlFiles(full));
    } else if (entry.endsWith('.toml')) {
      results.push(full);
    }
  }
  return results;
}

describe('Gemini CLI command TOML validation', () => {
  const tomlFiles = collectTomlFiles(COMMANDS_DIR);

  test('commands directory has toml files', () => {
    assert.ok(tomlFiles.length > 0, 'No .toml files found in commands/');
  });

  for (const file of tomlFiles) {
    const relPath = relative(join(import.meta.dirname, '../..'), file);

    test(`${relPath}: parses as valid TOML`, () => {
      const content = readFileSync(file, 'utf-8');
      assert.doesNotThrow(() => parseTOML(content), `Failed to parse TOML: ${relPath}`);
    });

    test(`${relPath}: has required "prompt" field`, () => {
      const content = readFileSync(file, 'utf-8');
      const parsed = parseTOML(content);
      assert.ok(
        typeof parsed.prompt === 'string' && parsed.prompt.trim().length > 0,
        `Missing or empty "prompt" field in ${relPath}. ` +
        `Gemini CLI custom commands require a "prompt" field. ` +
        `Found keys: [${Object.keys(parsed).join(', ')}]`
      );
    });

    test(`${relPath}: does not have MCP tool schema fields`, () => {
      const content = readFileSync(file, 'utf-8');
      const parsed = parseTOML(content);
      const mcpFields = ['name', 'inputSchema', 'parameters'];
      const found = mcpFields.filter(f => f in parsed);
      assert.strictEqual(
        found.length, 0,
        `${relPath} contains MCP tool fields [${found.join(', ')}] — ` +
        `these belong in server.ts, not in Gemini CLI command .toml files. ` +
        `Command .toml files only support: prompt (required), description (optional).`
      );
    });
  }
});
