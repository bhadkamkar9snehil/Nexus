import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { jevClient } from './key-routing.js';
import { chooseBoundedWithTypeSafe } from './typescript/jev_adapter.js';

const execute = promisify(execFile);
const root = join(import.meta.dirname, '..');
const cli = join(import.meta.dirname, 'node_modules', '@playwright', 'cli', 'playwright-cli.js');
type Node = { role?: string; name?: string; text?: string; ref?: string; disabled?: boolean; checked?: boolean; children?: Node[] };
type Input = { goal: string; url: string; expect: string; browser: 'chrome' | 'edge'; session: string; maxSteps: number; fields: Record<string, string> };

export async function playwrightBrowser(input: Input, addUsage: (usage: unknown) => void) {
  const session = 'jev-' + input.browser + '-' + input.session;
  const lock = join(root, '.sessions', session + '.lock');
  await mkdir(join(root, '.sessions'), { recursive: true });
  try { await mkdir(lock); } catch (error: any) {
    if (error.code === 'EEXIST') return JSON.stringify({ status: 'blocked', reason: 'session_busy', session, decisions: 0, steps: 0 });
    throw error;
  }
  const started = Date.now();
  const history: string[] = [];
  let decisions = 0;
  let reused = false;
  const result = (status: string, reason?: string) => JSON.stringify({ status, reason, backend: 'playwright', session, reused, elapsed_ms: Date.now() - started, decisions, steps: history.length, history });
  const call = async (...args: string[]) => {
    if (Date.now() - started > 120_000) throw new Error('Task time limit');
    const { stdout } = await execute(process.execPath, [cli, '-s=' + session, ...args, '--json'], {
      cwd: import.meta.dirname, timeout: Math.min(20_000, 120_000 - (Date.now() - started)),
      maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    const response = JSON.parse(stdout);
    if (response.isError) throw new Error('Playwright command failed');
    return response;
  };
  try {
    const existing = (await call('list')).browsers?.find((b: any) => b.name === session && b.status === 'open');
    reused = Boolean(existing);
    if (!existing) await call('open', input.url, '--browser=' + (input.browser === 'edge' ? 'msedge' : 'chrome'), '--persistent', '--profile=' + join(root, '.sessions', session), '--idle-timeout=1800000');
    else await call('goto', input.url);
    const jev = jevClient({ timeout: 8000, retry: { maxRetries: 0 }, logLevel: 'off' });
    for (let step = 0; step <= input.maxSteps; step++) {
      const snapshot = await call('snapshot');
      const nodes: Node[] = [];
      const walk = (items: Node[]) => { for (const node of items) { nodes.push(node); walk(node.children ?? []); } };
      walk(snapshot.snapshot ?? []);
      const visible = nodes.map(n => n.text ?? n.name ?? '').join('\n');
      if (visible.includes(input.expect)) return result('done');
      if (step === input.maxSteps) return result('blocked', 'step_limit');
      const candidates = nodes.filter(n => n.ref && !n.disabled && n.name)
        .filter(n => ['button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox'].includes(n.role ?? ''))
        .flatMap(n => {
          if (['textbox', 'searchbox'].includes(n.role!)) {
            const value = input.fields[n.name!];
            return value === undefined ? [] : [{ node: n, command: 'fill', value, description: 'Fill supplied value into ' + n.name }];
          }
          return [{ node: n, command: n.role === 'checkbox' ? (n.checked ? 'uncheck' : 'check') : 'click', value: undefined as string | undefined, description: (n.checked ? 'Uncheck ' : 'Activate ') + n.name }];
        }).slice(0, 24);
      const criteria = Object.fromEntries(candidates.map((c, i) => ['a' + i, c.description]));
      criteria.abstain = 'None of these actions advances the goal';
      decisions++;
      const choice = await chooseBoundedWithTypeSafe(jev, input.goal, {
        page: visible.slice(0, 8000), previous_actions: history,
      }, criteria);
      addUsage(choice.usage);
      if (choice.selectedId === 'abstain') return result('blocked', 'abstained');
      const action = candidates.find((_, i) => 'a' + i === choice.selectedId);
      if (!action) throw new Error('Invalid action');
      await call(action.command, action.node.ref!, ...(action.value === undefined ? [] : [action.value]));
      history.push(action.description);
    }
    return result('blocked', 'step_limit');
  } catch {
    return result('error', 'playwright_or_provider_failure');
  } finally {
    await rmdir(lock);
  }
}
