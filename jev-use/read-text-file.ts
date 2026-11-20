import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 48 * 1024;
const MAX_LINES = 250;

/** Resolves an absolute path inside the allowed roots (env var, else Documents and Downloads) and rejects protected locations. The file may not exist yet: its folder is resolved instead. */
export async function guardPath(path: string, allowedRoots: string[] | undefined, envName: string, mayBeNew = false): Promise<string> {
  const roots = allowedRoots ?? (process.env[envName]
    ? process.env[envName]!.split(';').map(s => s.trim()).filter(Boolean)
    : [join(homedir(), 'Documents'), join(homedir(), 'Downloads')]);
  if (!roots.length || roots.some(root => !isAbsolute(root))) throw new Error('Invalid roots');

  let resolved: string;
  try { resolved = await realpath(path); } catch (error) {
    if (!mayBeNew || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    resolved = join(await realpath(dirname(path)), basename(path));
  }
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  let allowed = false;
  for (const root of roots) {
    let resolvedRoot: string;
    try { resolvedRoot = await realpath(root); } catch { continue; }
    const anchor = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
    const part = relative(anchor, normalized);
    if (part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))) {
      allowed = true;
      break;
    }
  }
  if (!allowed) throw new Error('Path outside allowed roots');

  // Never expose or change local credentials or agent state through the generic text tools.
  if (/(^|[\\/])(?:\.git|secrets|ChromeProfile|EdgeProfile|node_modules)(?:[\\/]|$)/i.test(resolved) ||
      /(^|[\\/])\.env(?:\.[^\\/]*)?$/i.test(resolved) ||
      /\.(?:pem|p12|pfx|key)$/i.test(resolved) ||
      /(^|[\\/])runs\.jsonl$/i.test(resolved)) throw new Error('Protected file path');
  return resolved;
}

// Adopt Desktop Commander's line pagination, but keep this first tool text-only
// and enforce Nexus's own path boundary. No URL access or format conversion.
export async function readTextFile(options: {
  path: string;
  offset?: number;
  length?: number;
  allowedRoots?: string[];
}) {
  const { path } = options;
  const offset = options.offset ?? 0;
  const length = options.length ?? 100;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('path must be absolute');
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 1_000_000) throw new Error('Invalid offset');
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_LINES) throw new Error('Invalid length');

  const resolved = await guardPath(path, options.allowedRoots, 'NEXUS_READ_ROOTS');

  const info = await stat(resolved);
  if (!info.isFile()) throw new Error('Path is not a regular file');
  if (info.size > MAX_FILE_BYTES) throw new Error('File exceeds 8 MiB; use search_local');
  const buffer = await readFile(resolved);
  if (buffer.includes(0)) throw new Error(/\.(?:docx|xlsx|pdf)$/i.test(resolved) ? 'Binary file; use nexus_read_document for .docx, .xlsx and .pdf' : 'Binary file; text reader accepts UTF-8 only');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('File is not valid UTF-8'); }

  const lines = text.length ? text.split(/\r\n|\n|\r/) : [];
  if (lines.length && /(?:\r\n|\r|\n)$/.test(text)) lines.pop();
  const first = offset < 0 ? Math.max(0, lines.length + offset) : Math.min(offset, lines.length);
  let index = first;
  const output: string[] = [];
  let chars = 0;
  let lineTruncated = false;
  while (index < lines.length && index - first < length) {
    const line = lines[index];
    const room = MAX_OUTPUT_CHARS - chars - (output.length ? 1 : 0);
    if (room <= 0) break;
    if (line.length > room) {
      if (output.length) break;
      output.push(line.slice(0, room));
      lineTruncated = true;
      index++;
      break;
    }
    output.push(line);
    chars += line.length + (output.length > 1 ? 1 : 0);
    index++;
  }
  return {
    status: 'done', path: resolved, start_line: first + 1,
    total_lines: lines.length, lines_read: output.length,
    sha256: createHash('sha256').update(text).digest('hex'),
    content: output.join('\n'), next_offset: index < lines.length ? index : null,
    truncated: index < lines.length || lineTruncated, line_truncated: lineTruncated,
    decisions: 0,
  };
}
