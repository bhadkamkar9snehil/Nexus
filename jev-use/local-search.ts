import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpath, stat } from 'node:fs/promises';

export async function searchLocal(options: { root: string; pattern: string; limit?: number; glob?: string; regex?: boolean }) {
  const root = await realpath(options.root);
  if (!(await stat(root)).isDirectory()) throw new Error('Search root must be a folder');
  const limit = options.limit ?? 50;
  if (!options.pattern || options.pattern.length > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid search arguments');
  const args = ['--json', '--hidden', '--ignore-case', '--max-columns=2000', '--max-columns-preview', '--glob=!.env*', '--glob=!secrets/**', '--glob=!.git/**'];
  if (!options.regex) args.push('--fixed-strings');
  if (options.glob) args.push('--glob', options.glob);
  args.push('--', options.pattern, root);
  const matches: { path: string; line: number; text: string }[] = [];
  let truncated = false, timedOut = false, errorOutput = '';
  await new Promise<void>((resolve, reject) => {
    const child = spawn('rg', args, { shell: false, windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; truncated = true; child.kill(); }, 15000);
    child.stderr.on('data', c => { errorOutput += String(c).slice(0, 2000); });
    child.on('error', reject);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'match' || !event.data.path.text || !event.data.lines.text) return;
        if (matches.length >= limit) { truncated = true; child.kill(); return; }
        matches.push({ path: event.data.path.text, line: event.data.line_number, text: event.data.lines.text.trim().slice(0, 600) });
      } catch { /* Non-match JSON is ignored. */ }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || code === 1 || truncated) resolve();
      else reject(new Error('ripgrep failed: ' + errorOutput.slice(0, 2000)));
    });
  });
  return { status: 'done', matches, truncated, timed_out: timedOut, warnings: errorOutput.slice(0, 2000), decisions: 0, steps: 0 };
}
