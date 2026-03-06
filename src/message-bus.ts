import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
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
  private offsets: Map<string, number> = new Map();

  constructor(workDir: string = WORK_DIR) {
    this.inboxDir = join(workDir, 'inbox');
    mkdirSync(this.inboxDir, { recursive: true });
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

    this.offsets.set(agentName, lines.length);

    return newLines.map((line) => JSON.parse(line) as Message);
  }

  broadcast(from: string, agents: string[], type: MessageType, payload: unknown): Message[] {
    return agents.map((to) => this.send({ from, to, type, payload }));
  }
}
