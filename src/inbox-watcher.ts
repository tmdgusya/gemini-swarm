import { watch, type FSWatcher, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

export class InboxWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private inboxDir: string;

  constructor(inboxDir: string) {
    super();
    this.inboxDir = inboxDir;
    if (!existsSync(this.inboxDir)) {
      mkdirSync(this.inboxDir, { recursive: true });
    }
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = watch(this.inboxDir, (eventType, filename) => {
      if (eventType === 'change' && filename?.endsWith('.jsonl')) {
        const agentName = filename.replace('.jsonl', '');
        this.emit('message', agentName);
      }
    });

    this.watcher.on('error', (err) => {
      this.emit('error', err);
    });
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
