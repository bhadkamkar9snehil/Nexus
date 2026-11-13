import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { jevClient } from './key-routing.js';
import { chooseBoundedWithTypeSafe } from './typescript/jev_adapter.js';

const execute = promisify(execFile);
type Options = { pattern: string; drive: string; kind: 'any' | 'file' | 'folder'; limit: number; pathFilter?: string; query?: string };
type FileRow = { path: string; name: string; size: number; isDirectory: boolean; treeSize: number };

export function uffsExecutable() {
  const bundled = join(import.meta.dirname, '..', 'runtime', 'uffs.exe');
  if (existsSync(bundled)) return bundled;
  const alias = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'uffs.exe');
  if (existsSync(alias)) return alias;
  const packageExe = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages', 'SkyLLC.UFFS_Microsoft.Winget.Source_8wekyb3d8bbwe', 'uffs-windows-x64', 'uffs.exe');
  return existsSync(packageExe) ? packageExe : 'uffs';
}

export async function searchStatus() {
  const { stdout } = await execute(uffsExecutable(), ['--daemon', 'status', '--json'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
  const data = JSON.parse(stdout);
  return JSON.stringify({
    status: data.running ? 'done' : 'idle', running: data.running,
    version: data.status?.version ?? data.stats?.version, pid: data.status?.pid,
    readingViaBroker: data.status?.reading_via_broker, drives: data.drives,
    records: data.stats?.total_records, startup_ms: data.stats?.startup_duration_ms,
    workingSetBytes: data.status?.rss_bytes, indexHeapBytes: data.status?.index_heap_bytes,
    liveUpdateLoops: data.status?.live_update?.active_loops, decisions: 0, steps: 0,
  });
}

export async function findFiles(options: Options, addUsage: (usage: unknown) => void) {
  const started = Date.now();
  const executable = uffsExecutable();
  const args = ['--search', options.pattern, '--drive', options.drive, '--format', 'json', '--limit', String(options.limit + 1)];
  if (options.kind !== 'any') args.push(options.kind === 'file' ? '--files-only' : '--dirs-only');
  if (options.pathFilter) args.push('--in-path', options.pathFilter);
  let output;
  try {
    output = await execute(executable, args, { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error('UFFS search unavailable. Check installation and uffs-broker --status / uffs --daemon status. No recursive fallback was run.');
  }
  const rows: FileRow[] = output.stdout.split(/\r?\n/).filter(Boolean).map(line => {
    const row = JSON.parse(line);
    if (typeof row.path !== 'string' || typeof row.name !== 'string' || typeof row.is_directory !== 'boolean') throw new Error('Unexpected UFFS output');
    return { path: row.path, name: row.name, size: row.size, isDirectory: row.is_directory, treeSize: row.treesize };
  });
  const limited = rows.length > options.limit;
  const matches = rows.slice(0, options.limit);
  const searchMs = Date.now() - started;
  let best: FileRow | null = null;
  let decisions = 0;
  if (options.query && matches.length) {
    const candidates = matches.slice(0, 24);
    const criteria = Object.fromEntries(candidates.map((row, index) => ['f' + index, JSON.stringify(row)]));
    criteria.none = 'No candidate matches the request';
    const answer = await chooseBoundedWithTypeSafe(jevClient({ timeout: 8000, retry: { maxRetries: 0 }, logLevel: 'off' }), options.query,
      { source: 'NTFS metadata, content not inspected' }, criteria);
    addUsage(answer.usage);
    decisions = 1;
    best = answer.selectedId === 'none' ? null : candidates[Number(answer.selectedId.slice(1))];
  }
  return JSON.stringify({ status: 'done', engine: 'uffs', matches, best, limited, rankedCandidates: options.query ? Math.min(24, matches.length) : 0, search_ms: searchMs, elapsed_ms: Date.now() - started, decisions, steps: 0 });
}
