import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { guardPath } from './read-text-file.js';

const MAX_BYTES = 1024 * 1024;
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function existing(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Path is not a regular file');
    if (info.size > MAX_BYTES) throw new Error('File exceeds 1 MiB; use a terminal tool');
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Replace through a temp file in the same folder so a failed write never leaves a half-written target.
async function replaceFile(path: string, content: string) {
  const temp = `${path}.nexus-${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temp, path);
}

function utf8(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('Binary file; text tools accept UTF-8 only');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('File is not valid UTF-8'); }
}

/** Creates a text file, or replaces one only when overwrite is true and, if given, the current content still matches expected_sha256. */
export async function writeTextFile(options: { path: string; content: string; overwrite?: boolean; expected_sha256?: string; allowedRoots?: string[] }) {
  const { path, content } = options;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('path must be absolute');
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new Error('content required, at most 1 MiB');
  const resolved = await guardPath(path, options.allowedRoots, 'NEXUS_WRITE_ROOTS', true);
  const current = await existing(resolved);
  if (current) {
    if (options.overwrite !== true) throw new Error('File exists; set overwrite=true to replace it');
    const text = utf8(current);
    if (options.expected_sha256 !== undefined && sha256(text) !== options.expected_sha256.toLowerCase()) throw new Error('File changed since it was read (expected_sha256 mismatch)');
  } else if (options.expected_sha256 !== undefined) throw new Error('expected_sha256 given but the file does not exist');
  await replaceFile(resolved, content);
  return { status: 'done', path: resolved, created: !current, bytes: Buffer.byteLength(content), sha256: sha256(content), decisions: 0 };
}

/** Replaces exact text in an existing file; fails unless old_text occurs exactly expected_replacements times (default 1). */
export async function editTextFile(options: { path: string; old_text: string; new_text: string; expected_replacements?: number; allowedRoots?: string[] }) {
  const { path, old_text, new_text } = options;
  const expected = options.expected_replacements ?? 1;
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('path must be absolute');
  if (typeof old_text !== 'string' || !old_text || typeof new_text !== 'string') throw new Error('old_text and new_text required');
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > 1000) throw new Error('Invalid expected_replacements');
  const resolved = await guardPath(path, options.allowedRoots, 'NEXUS_WRITE_ROOTS');
  const current = await existing(resolved);
  if (!current) throw new Error('File does not exist');
  const text = utf8(current);
  const found = text.split(old_text).length - 1;
  if (found !== expected) throw new Error(`old_text found ${found} times, expected ${expected}; nothing changed`);
  const updated = text.split(old_text).join(new_text);
  if (Buffer.byteLength(updated) > MAX_BYTES) throw new Error('Result exceeds 1 MiB');
  await replaceFile(resolved, updated);
  return { status: 'done', path: resolved, replacements: found, bytes: Buffer.byteLength(updated), sha256: sha256(updated), decisions: 0 };
}
