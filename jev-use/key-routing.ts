import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TypeSafeClient, type TypeSafeClientConfig } from '@typesafe-ai/sdk';

const context = new AsyncLocalStorage<string>();
const root = join(import.meta.dirname, '..');

export function resolveToolKey(tool: string, mapping: Record<string, unknown>, fallback: string | undefined, load: (alias: string) => string | undefined) {
  const alias = mapping[tool];
  if (alias === undefined) return fallback;
  if (typeof alias !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(alias)) throw new Error('Invalid key alias for ' + tool);
  const key = load(alias);
  if (!key) throw new Error('Could not load configured key for ' + tool);
  return key;
}

export function toolKey(tool = context.getStore() ?? '') {
  const path = join(root, 'secrets', 'tool-keys.json');
  let mapping: unknown = {};
  try { if (existsSync(path)) mapping = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Could not read tool key mapping'); }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid tool key mapping');
  return resolveToolKey(tool, mapping as Record<string, unknown>, process.env.TYPESAFE_API_KEY, alias => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'Read-ComputerUseKey.ps1'), '-Alias', alias], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? result.stdout.trim() : undefined;
  });
}

export function withToolKey<T>(tool: string, task: () => T): T { return context.run(tool, task); }
export function jevClient(config: TypeSafeClientConfig = {}) { return new TypeSafeClient({ ...config, apiKey: toolKey() }); }
