import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeArgs } from '../../agent-responder.mjs';
import { describeSessions, discoverSessions, formatSessionContext, saveSession, selectWorkspace } from '../../sessions.mjs';

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

test('discoverSessions finds Antigravity, Claude, and Codex sessions and scrubs secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-disc-root-'));
  const home = await mkdtemp(join(tmpdir(), 'nexus-disc-home-'));
  const wsAgy = await mkdtemp(join(tmpdir(), 'nexus-ws-agy-'));
  const wsCodex = await mkdtemp(join(tmpdir(), 'nexus-ws-codex-'));

  const agyId = '11111111-2222-3333-4444-555555555555';
  const agyDir = join(home, '.gemini', 'antigravity', 'brain', agyId, '.system_generated', 'logs');
  await mkdir(agyDir, { recursive: true });
  await writeFile(join(agyDir, 'transcript.jsonl'), [
    JSON.stringify({ type: 'USER_INPUT', content: `<USER_REQUEST>Fix routing evaluator #104 in ${wsAgy}</USER_REQUEST>` }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Routing evaluator tests passed; token glpat-secret1234567890 redacted.' }),
  ].join('\n'));

  const claudeDir = join(home, '.claude', 'projects', 'c--work-XMES');
  const claudeReplyDir = join(home, '.claude', 'projects', 'nexus-reply-temp123');
  await mkdir(claudeDir, { recursive: true });
  await mkdir(claudeReplyDir, { recursive: true });
  await writeFile(join(claudeDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), [
    JSON.stringify({ type: 'user', cwd: wsAgy, message: { role: 'user', content: 'Check RM operator screen' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Found overlap in #142' }] } }),
  ].join('\n'));
  await writeFile(join(claudeReplyDir, '99999999-0000-0000-0000-000000000000.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'ignore me' } }));

  const codexDir = join(home, '.codex', 'sessions', '2026', '11', '27');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, 'rollout-1.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { id: 'codex-1', cwd: wsCodex } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Quota bucketing #107' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed account identifier collision.' } }),
  ].join('\n'));

  const found = await discoverSessions(root, { home });
  assert.equal(found.length, 3);
  const agy = found.find(s => s.id === agyId);
  assert.ok(agy && agy.host === 'antigravity' && agy.cwd === wsAgy);
  assert.ok(agy.summary.includes('[REDACTED]') && !agy.summary.includes('glpat-secret1234567890'));
  assert.ok(found.some(s => s.host === 'claude' && s.summary.includes('#142')));
  assert.ok(found.some(s => s.host === 'codex' && s.cwd === wsCodex));

  const picked = await selectWorkspace(found, 'Update on quota bucketing #107', home);
  assert.equal(picked, wsCodex);

  const ctx = formatSessionContext(found, { own: false });
  assert.ok(ctx.includes('[antigravity]') && ctx.includes('[claude]') && ctx.includes('[codex]'));
});

test('claudeArgs grants read-only workspace, GitLab, and gbrain tools in safe mode', () => {
  const mateArgs = claudeArgs('safe', false, 'C:\\tmp\\mcp.json');
  const allowed = mateArgs[mateArgs.indexOf('--allowedTools') + 1];
  assert.ok(allowed.includes('Read') && allowed.includes('Grep') && allowed.includes('Glob'));
  assert.ok(allowed.includes('mcp__gitlab__list_issues') && allowed.includes('mcp__gbrain__query'));
  assert.ok(!allowed.includes('Write') && !allowed.includes('Edit'));
});
