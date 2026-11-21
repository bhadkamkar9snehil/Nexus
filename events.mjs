// Event log behind the MCP Events extension (io.modelcontextprotocol/events). The monitor host is the single writer
// (GitLab webhooks, peer mail); MCP server processes only read. Rows carry a rising seq; a cursor is "s<seq>".
// Payloads are minimal on purpose: enough to triage, with full content fetched through tools.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const KEEP = 1000, ROTATE_AT = 2000;
const file = (root) => join(process.env.NEXUS_EVENTS_DIR || join(root, 'secrets'), 'events.jsonl');

async function rows(root) {
  let text = '';
  try { text = await readFile(file(root), 'utf8'); } catch { /* no events yet */ }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a partial line */ }
  }
  return out;
}

/** Appends one occurrence. `eventId` should be the upstream's stable id (GitLab delivery UUID, mailbox message id). */
export function emit(root, event) {
  // Serialized so two simultaneous webhooks never share a seq.
  const next = queue.then(() => append(root, event));
  queue = next.catch(() => {});
  return next;
}
let queue = Promise.resolve();

async function append(root, { name, eventId, data, deduplicate = false }) {
  const all = await rows(root);
  if (deduplicate && eventId && all.some(row => row.name === name && row.eventId === eventId)) return null;
  const row = { seq: (all.at(-1)?.seq ?? 0) + 1, eventId: eventId || randomBytes(8).toString('hex'), name, timestamp: new Date().toISOString(), data };
  await mkdir(join(file(root), '..'), { recursive: true });
  if (all.length >= ROTATE_AT) {
    await writeFile(file(root), [...all.slice(-KEEP), row].map(r => JSON.stringify(r) + '\n').join(''));
  } else await appendFile(file(root), JSON.stringify(row) + '\n');
  return row;
}

export const cursorOf = (seq) => 's' + seq;
export function parseCursor(cursor) {
  const m = /^s(\d{1,15})$/.exec(cursor ?? '');
  if (!m) throw new Error('Invalid cursor');
  return Number(m[1]);
}

/** Occurrences after `afterSeq` for one event name, plus the log head and oldest retained seq (to detect a gap). */
export async function readEvents(root, { name, afterSeq, match = () => true }) {
  const all = await rows(root);
  return { head: all.at(-1)?.seq ?? 0, first: all[0]?.seq ?? 1, rows: all.filter(r => r.name === name && r.seq > afterSeq && match(r.data)) };
}
