import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpath, stat } from 'node:fs/promises';
import { jevClient } from './key-routing.js';
import { chooseBoundedWithTypeSafe } from './typescript/jev_adapter.js';

export async function searchContent(root: string, pattern: string, query: string, addUsage: (usage: unknown) => void) {
  const path = await realpath(root);
  if (!(await stat(path)).isDirectory()) throw new Error('Search root must be a folder');
  const started = Date.now();
  const matches: { path: string; line: number; text: string }[] = [];
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('rg', ['--json', '--fixed-strings', '--ignore-case', '--max-filesize=4M', '--glob=!.env*', '--glob=!secrets/**', '--', pattern, path], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let bytes = 0;
    const timer = setTimeout(() => { truncated = true; child.kill(); }, 10_000);
    child.on('error', reject);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { truncated = true; child.kill(); } });
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'match' || !event.data.path.text || !event.data.lines.text) return;
        if (matches.length >= 24) { truncated = true; child.kill(); return; }
        matches.push({ path: event.data.path.text, line: event.data.line_number, text: event.data.lines.text.trim().slice(0, 600) });
      } catch { /* Non-result output is ignored. */ }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || code === 1 || truncated) resolve();
      else reject(new Error('ripgrep failed'));
    });
  });
  if (!matches.length) return JSON.stringify({ status: 'done', matches: [], truncated, decisions: 0, steps: 0, elapsed_ms: Date.now() - started });
  const criteria = Object.fromEntries(matches.map((match, i) => ['m' + i, JSON.stringify(match)]));
  criteria.none = 'None of these excerpts answers the query';
  const answer = await chooseBoundedWithTypeSafe(
    jevClient({ timeout: 8000, retry: { maxRetries: 0 }, logLevel: 'off' }),
    'Which excerpt best answers this search request? ' + query,
    { scope: path, candidate_count: matches.length }, criteria,
  );
  addUsage(answer.usage);
  const best = answer.selectedId === 'none' ? null : matches[Number(answer.selectedId.slice(1))];
  return JSON.stringify({ status: 'done', best, confidence: answer.confidence, matches, truncated, decisions: 1, steps: 0, elapsed_ms: Date.now() - started });
}
