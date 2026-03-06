import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SwarmConfig } from './types.js';

const DEFAULT_CONFIG: SwarmConfig = {
  maxAgents: 5,
  workDir: process.cwd(),
  useWorktrees: false,
  timeout: 300_000,
};

export function loadConfig(configPath?: string): SwarmConfig {
  const path = configPath ?? join(process.cwd(), 'swarm.json');
  if (!existsSync(path)) return { ...DEFAULT_CONFIG, workDir: process.cwd() };
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  return { ...DEFAULT_CONFIG, ...raw, workDir: raw.workDir ?? process.cwd() };
}
