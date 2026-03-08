import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORK_DIR } from './types.js';

export type MessageType = 'task' | 'result' | 'info' | 'error' | 'heartbeat' | 'ack';

export interface Message {
  id: string;
  from: string;
  to: string;
  type: MessageType;
  payload: unknown;
  timestamp: string;
  ackId?: string; // ID of the message being acknowledged
}

export class MessageBus {
  private inboxDir: string;
  private offsetsFile: string;
  private pendingAcksFile: string;
  private offsets: Map<string, number> = new Map();
  private pendingAcks: Map<string, Message> = new Map();

  constructor(workDir: string = WORK_DIR) {
    this.inboxDir = join(workDir, 'inbox');
    this.offsetsFile = join(workDir, 'offsets.json');
    this.pendingAcksFile = join(workDir, 'pending_acks.json');
    mkdirSync(this.inboxDir, { recursive: true });
    this.loadOffsets();
    this.loadPendingAcks();
  }

  saveOffsets(): void {
    const data = JSON.stringify(Object.fromEntries(this.offsets), null, 2);
    const tmpFile = `${this.offsetsFile}.tmp`;
    writeFileSync(tmpFile, data);
    renameSync(tmpFile, this.offsetsFile);
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

  savePendingAcks(): void {
    const data = JSON.stringify(Object.fromEntries(this.pendingAcks), null, 2);
    const tmpFile = `${this.pendingAcksFile}.tmp`;
    writeFileSync(tmpFile, data);
    renameSync(tmpFile, this.pendingAcksFile);
  }

  loadPendingAcks(): void {
    if (!existsSync(this.pendingAcksFile)) return;
    try {
      const data = readFileSync(this.pendingAcksFile, 'utf-8');
      const obj = JSON.parse(data);
      this.pendingAcks = new Map(Object.entries(obj));
    } catch (err) {
      console.error(`Failed to load pending ACKs from ${this.pendingAcksFile}:`, err);
    }
  }

  send(opts: { from: string; to: string; type: MessageType; payload: unknown; ackId?: string; requireAck?: boolean }): Message {
    const msg: Message = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from: opts.from,
      to: opts.to,
      type: opts.type,
      payload: opts.payload,
      timestamp: new Date().toISOString(),
      ackId: opts.ackId,
    };

    if (opts.requireAck) {
      this.pendingAcks.set(msg.id, msg);
      this.savePendingAcks();
    }

    const filePath = join(this.inboxDir, `${opts.to}.jsonl`);
    appendFileSync(filePath, JSON.stringify(msg) + '\n');
    return msg;
  }

  sendAck(from: string, to: string, ackId: string): Message {
    return this.send({
      from,
      to,
      type: 'ack',
      payload: { acked: true },
      ackId,
    });
  }

  getPendingAcks(): Message[] {
    return Array.from(this.pendingAcks.values());
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

    const messages: Message[] = [];
    let corruptLines = 0;
    for (const line of newLines) {
      try {
        messages.push(JSON.parse(line) as Message);
      } catch {
        corruptLines++;
      }
    }
    if (corruptLines > 0) {
      console.error(`[message-bus] Skipped ${corruptLines} invalid JSON lines in inbox for ${agentName}`);
    }

    if (newLines.length > 0) {
      this.offsets.set(agentName, lines.length);
      this.saveOffsets();
    }

    let changed = false;
    for (const msg of messages) {
      if (msg.type === 'ack' && msg.ackId) {
        if (this.pendingAcks.has(msg.ackId)) {
          this.pendingAcks.delete(msg.ackId);
          changed = true;
        }
      }
    }

    if (changed) {
      this.savePendingAcks();
    }

    return messages;
  }

  broadcast(from: string, agents: string[], type: MessageType, payload: unknown, requireAck?: boolean): Message[] {
    return agents.map((to) => this.send({ from, to, type, payload, requireAck }));
  }
}
