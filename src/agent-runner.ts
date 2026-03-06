import { spawn, type ChildProcess } from 'node:child_process';
import type { GeminiStreamEvent, GeminiStats } from './types.js';

export interface RunnerConfig {
  model?: string;
  timeout: number;
  geminiPath?: string;
  extraFlags?: string[];
}

export interface RunOptions {
  prompt: string;
  cwd: string;
  context?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  status: 'completed' | 'failed';
  response: string;
  stats?: GeminiStats;
  error?: string;
  durationMs: number;
  events: GeminiStreamEvent[];
}

export class AgentRunner {
  private config: RunnerConfig;

  constructor(config: RunnerConfig) {
    this.config = config;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const startTime = Date.now();
    const gemini = this.config.geminiPath ?? 'gemini';

    const args: string[] = ['-p', opts.prompt, '-y', '-o', 'stream-json'];
    if (this.config.model) {
      args.push('-m', this.config.model);
    }
    if (this.config.extraFlags) {
      args.push(...this.config.extraFlags);
    }

    return new Promise<RunResult>((resolve) => {
      const proc: ChildProcess = spawn(gemini, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Write context to stdin if provided, then close
      if (opts.context) {
        proc.stdin?.write(opts.context);
      }
      proc.stdin?.end();

      // Timeout handling
      let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutId = setTimeout(() => {
        killed = true;
        // Kill the process group so child processes (e.g. shell scripts) also die
        if (proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGTERM');
          } catch {
            proc.kill('SIGTERM');
          }
        } else {
          proc.kill('SIGTERM');
        }
        sigkillTimer = setTimeout(() => {
          if (proc.pid) {
            try {
              process.kill(-proc.pid, 'SIGKILL');
            } catch {
              // Process may already be dead
            }
          }
          try {
            proc.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }, 5000);
      }, this.config.timeout);

      proc.on('close', (code) => {
        clearTimeout(timeoutId);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        const durationMs = Date.now() - startTime;
        const events = AgentRunner.parseStreamJson(stdout);

        if (killed) {
          resolve({
            status: 'failed',
            response: '',
            error: `Process timed out after ${this.config.timeout}ms`,
            durationMs,
            events,
          });
          return;
        }

        // Look for result and error events
        const resultEvent = events.find((e) => e.type === 'result');
        const errorEvent = events.find((e) => e.type === 'error');

        if (errorEvent) {
          resolve({
            status: 'failed',
            response: '',
            error: errorEvent.error ?? 'Unknown error from Gemini',
            durationMs,
            events,
          });
          return;
        }

        if (resultEvent) {
          // The result event may not carry a response field.
          // Assemble response from assistant message events as fallback.
          const response = resultEvent.response
            ?? events
              .filter((e) => e.type === 'message' && (e as any).role === 'assistant' && e.content)
              .map((e) => e.content!)
              .join('');
          resolve({
            status: 'completed',
            response,
            stats: resultEvent.stats,
            durationMs,
            events,
          });
          return;
        }

        // Fallback: extract response from message events or raw stdout
        if (events.length > 0) {
          const messageTexts = events
            .filter((e) => e.type === 'message' && e.content)
            .map((e) => e.content!)
            .join('');
          resolve({
            status: code === 0 ? 'completed' : 'failed',
            response: messageTexts || stdout.trim(),
            error: code !== 0 ? `Process exited with code ${code}` : undefined,
            durationMs,
            events,
          });
          return;
        }

        // No valid events parsed — use raw text
        const rawText = stdout.trim();
        resolve({
          status: code === 0 ? 'completed' : 'failed',
          response: rawText,
          error: code !== 0
            ? stderr.trim() || `Process exited with code ${code}`
            : undefined,
          durationMs,
          events: [],
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;
        resolve({
          status: 'failed',
          response: '',
          error: err.message,
          durationMs,
          events: [],
        });
      });
    });
  }

  /**
   * Parse NDJSON stdout into GeminiStreamEvent[].
   * Each line is expected to be a JSON object.
   * Invalid lines are silently skipped.
   */
  static parseStreamJson(raw: string): GeminiStreamEvent[] {
    const events: GeminiStreamEvent[] = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
          events.push(parsed as GeminiStreamEvent);
        }
      } catch {
        // Skip non-JSON lines
      }
    }
    return events;
  }
}
