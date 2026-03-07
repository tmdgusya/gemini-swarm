import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type MessageType = 'task' | 'result' | 'info' | 'error' | 'heartbeat';

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: string;
}

const WORK_DIR = '/tmp/gemini-swarm';

export class MessageBus {
  private inboxDir: string;
  private offsetsFile: string;
  private offsets: Map<string, number> = new Map();

  constructor(workDir: string = WORK_DIR) {
    this.inboxDir = join(workDir, 'inbox');
    this.offsetsFile = join(workDir, 'offsets.json');
    mkdirSync(this.inboxDir, { recursive: true });
    this.loadOffsets();
  }

  saveOffsets(): void {
    const data = JSON.stringify(Object.fromEntries(this.offsets), null, 2);
    writeFileSync(this.offsetsFile, data);
  }

  loadOffsets(): void {
    if (!existsSync(this.offsetsFile)) return;
    try {
      const data = readFileSync(this.offsetsFile, 'utf-8');
      const obj = JSON.parse(data);
      this.offsets = new Map(Object.entries(obj));
    } catch (err) {
      console.error(`Failed to load offsets from ${this.offsetsFile}:`, err);
    }
  }

  send(opts: { from: string; to: string; type: MessageType; payload: unknown }): Message {
    const msg: Message = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from: opts.from,
      to: opts.to,
      type: opts.type,
      payload: opts.payload,
      timestamp: new Date().toISOString(),
    };

    const filePath = join(this.inboxDir, `${opts.to}.jsonl`);
    appendFileSync(filePath, JSON.stringify(msg) + '\n');
    return msg;
  }

  receive(agentName: string): Message[] {
    const filePath = join(this.inboxDir, `${agentName}.jsonl`);

    if (!existsSync(filePath)) {
      return [];
    }

    const content = readFileSync(filePath, 'utf-8');
    const offset = this.offsets.get(agentName) ?? 0;

    const lines = content.split('\n').filter((line) => line.length > 0);
    const newLines = lines.slice(offset);

    if (newLines.length > 0) {
      this.offsets.set(agentName, lines.length);
      this.saveOffsets();
    }

    return newLines.map((line) => JSON.parse(line) as Message);
  }

  broadcast(from: string, agents: string[], type: MessageType, payload: unknown): Message[] {
    return agents.map((to) => this.send({ from, to, type, payload }));
  }
}
