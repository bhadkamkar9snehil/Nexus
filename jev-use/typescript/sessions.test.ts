import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { describeSessions, saveSession } from '../../sessions.mjs';

const hook = fileURLToPath(new URL('../../nexus-hook.mjs', import.meta.url));

test('teammates see only published claims; own computers also see folder and last request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-sessions-'));
  await saveSession(root, 'a', { cwd: 'C:\\work\\XMES', topic: 'private prompt' });
  assert.equal(await describeSessions(root, false), '');
  await saveSession(root, 'a', { claim: 'RM operator screen in Vi' });
  const mate = await describeSessions(root, false);
  assert.ok(mate.includes('RM operator screen') && !mate.includes('private prompt') && !mate.includes('XMES'));
  const mine = await describeSessions(root, true);
  assert.ok(mine.includes('private prompt') && mine.includes('XMES'));
});

test('hook install repoints Nexus hooks once and keeps other hooks and settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-install-'));
  const other = { type: 'command', command: 'python block.py' };
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [other] }], Stop: [{ hooks: [{ type: 'command', command: 'node "C:/old/nexus-hook.mjs"' }, other] }] } }));
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [hook, 'install'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.PreToolUse.length, 1);
  const stop = settings.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map(h => h.command));
  assert.equal(stop.length, 2);
  assert.ok(stop.includes(other.command) && !stop.some((c: string) => c.includes('C:/old/')));
});
