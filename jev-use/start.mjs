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
    // Keep serving: search, file and network tools need no key. Only Jev tools fail, with a clear message.
    // DPAPI keys are per Windows user and machine; a copied computeruse_1.xml cannot be decrypted. Re-run Set-ComputerUseKey.ps1.
    console.error('WARNING: could not decrypt secrets\\computeruse_1.xml (wrong Windows user or machine?). Jev tools are unavailable until Set-ComputerUseKey.ps1 is run; find_files, search_local and network_probe still work.');
  } else {
    process.env.TYPESAFE_API_KEY = result.stdout.trim();
  }
}
process.env.TYPESAFE_LOG_LEVEL = 'off';
await import('./shared.ts');
