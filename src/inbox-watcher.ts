import { watch, type FSWatcher, existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';

export class InboxWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private inboxDir: string;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;

  constructor(inboxDir: string, debounceMs = 50) {
    super();
    this.inboxDir = inboxDir;
    this.debounceMs = debounceMs;
    if (!existsSync(this.inboxDir)) {
      mkdirSync(this.inboxDir, { recursive: true });
    }
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = watch(this.inboxDir, (eventType, filename) => {
      if ((eventType === 'change' || eventType === 'rename') && filename?.endsWith('.jsonl')) {
        const agentName = filename.replace('.jsonl', '');
        // Debounce: merge consecutive events for the same agent
        if (this.debounceTimers.has(agentName)) {
          clearTimeout(this.debounceTimers.get(agentName));
        }
        this.debounceTimers.set(agentName, setTimeout(() => {
          this.debounceTimers.delete(agentName);
          this.emit('message', agentName);
        }, this.debounceMs));
      }
    });
    this.watcher.on('error', (err) => { this.emit('error', err); });
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  }
}
