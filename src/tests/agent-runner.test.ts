import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunner } from '../agent-runner.js';
import type { GeminiStreamEvent } from '../types.js';

describe('AgentRunner.parseStreamJson', () => {
  it('parses valid NDJSON lines into events', () => {
    const input = [
      JSON.stringify({ type: 'init', session_id: 'abc123' }),
      JSON.stringify({ type: 'message', content: 'Hello' }),
      JSON.stringify({
        type: 'result',
        response: 'Done',
        stats: {
          models: [{ modelId: 'gemini-2.5-pro', inputTokens: 10, outputTokens: 5, thinkingTokens: 0 }],
          tools: [],
        },
      }),
    ].join('\n');

    const events = AgentRunner.parseStreamJson(input);
    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'init');
    assert.equal(events[0].session_id, 'abc123');
    assert.equal(events[1].type, 'message');
    assert.equal(events[1].content, 'Hello');
    assert.equal(events[2].type, 'result');
    assert.equal(events[2].response, 'Done');
    assert.ok(events[2].stats);
    assert.equal(events[2].stats!.models[0].modelId, 'gemini-2.5-pro');
  });

  it('skips empty lines and invalid JSON', () => {
    const input = [
      '',
      'not json at all',
      '{ broken json',
      JSON.stringify({ type: 'message', content: 'valid' }),
      '',
      '12345',
      JSON.stringify({ noType: true }),
    ].join('\n');

    const events = AgentRunner.parseStreamJson(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'message');
    assert.equal(events[0].content, 'valid');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(AgentRunner.parseStreamJson(''), []);
    assert.deepEqual(AgentRunner.parseStreamJson('  \n  \n  '), []);
  });

  it('parses error events', () => {
    const input = JSON.stringify({ type: 'error', error: 'Something went wrong' });
    const events = AgentRunner.parseStreamJson(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].error, 'Something went wrong');
  });

  it('parses tool_use and tool_result events', () => {
    const input = [
      JSON.stringify({ type: 'tool_use', tool_name: 'read_file', tool_input: { path: '/tmp/x' } }),
      JSON.stringify({ type: 'tool_result', tool_name: 'read_file', tool_output: 'file contents' }),
    ].join('\n');

    const events = AgentRunner.parseStreamJson(input);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool_use');
    assert.equal(events[0].tool_name, 'read_file');
    assert.equal(events[1].type, 'tool_result');
    assert.equal(events[1].tool_output, 'file contents');
  });
});

describe('AgentRunner.run', () => {
  it('handles spawn error for nonexistent binary', async () => {
    const runner = new AgentRunner({
      timeout: 5000,
      geminiPath: '/nonexistent/binary/path',
    });

    const result = await runner.run({
      prompt: 'test',
      cwd: '/tmp',
    });

    assert.equal(result.status, 'failed');
    assert.ok(result.error);
    assert.ok(result.durationMs >= 0);
  });

  it('handles timeout correctly', async () => {
    // Create a helper script that sleeps, ignoring all CLI args
    const fs = await import('node:fs');
    const sleepScript = '/tmp/gemini-swarm-test-sleep.sh';
    fs.writeFileSync(sleepScript, '#!/bin/bash\nsleep 60\n', { mode: 0o755 });

    const runner = new AgentRunner({
      timeout: 500,
      geminiPath: sleepScript,
    });

    const result = await runner.run({
      prompt: 'test',
      cwd: '/tmp',
    });

    fs.unlinkSync(sleepScript);

    assert.equal(result.status, 'failed');
    assert.ok(result.error?.includes('timed out'), `Expected timeout error, got: "${result.error}"`);
    assert.ok(result.durationMs >= 100, `Expected duration >= 100ms, got ${result.durationMs}ms`);
  });

  it('runs a simple gemini prompt', async () => {
    const runner = new AgentRunner({
      timeout: 60000,
      geminiPath: 'gemini',
    });

    const result = await runner.run({
      prompt: 'What is 2+2? Reply with just the number.',
      cwd: '/tmp',
    });

    // We expect either a successful result or a failure if gemini is not configured
    if (result.status === 'completed') {
      assert.ok(result.response.includes('4'), `Expected response to contain "4", got: "${result.response}"`);
      assert.ok(result.durationMs > 0);
    } else {
      // If gemini CLI is not configured/authenticated, it will fail — that's acceptable
      assert.ok(result.error, 'Expected error message on failure');
    }
  });
});
