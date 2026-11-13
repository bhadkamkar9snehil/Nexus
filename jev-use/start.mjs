import './node_modules/tsx/dist/loader.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
process.env.PATH = join(import.meta.dirname, '..', 'runtime') + ';' + (process.env.PATH ?? '');

const secret = join(import.meta.dirname, '..', 'secrets', 'computeruse_1.xml');
if (existsSync(secret)) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(import.meta.dirname, 'Read-ComputerUseKey.ps1'),
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0 || !result.stdout?.trim()) {
    console.error('Could not load the computeruse_1 credential.');
    process.exit(1);
  }
  process.env.TYPESAFE_API_KEY = result.stdout.trim();
}
process.env.TYPESAFE_LOG_LEVEL = 'off';
await import('./shared.ts');
