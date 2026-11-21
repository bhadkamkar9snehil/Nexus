import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dirname, '..', '..', 'Update-Nexus.ps1');
const sha = 'a'.repeat(64);
const release = (tag: string) => ({ tag_name: tag, description: `## Checksums\n- Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe: SHA256 ${sha}`,
  assets: { links: [{ name: `Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe`, url: `http://10.2.6.112:8080/api/v4/projects/55/packages/generic/nexus-harness/${tag.slice(1)}/Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe` }] } });

async function decide(options: { installed?: string; idle?: number; running?: boolean; autoUpdate?: boolean; releases?: unknown[] }) {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-auto-update-'));
  await mkdir(join(dir, 'Nexus'), { recursive: true });
  if (options.autoUpdate === false) await writeFile(join(dir, 'Nexus', 'updates.json'), '{"autoUpdate":false}');
  const releases = join(dir, 'releases.json');
  await writeFile(releases, JSON.stringify(options.releases ?? [release('v1.17.0'), release('v1.16.1')]));
  const runs = join(dir, 'runs.json');
  await writeFile(runs, JSON.stringify(options.running ? [{ status: 'running', started: Date.now() - 5000 }] : [{ status: 'passed', started: Date.now() - 600000 }]));
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun', '-ReleasesJson', releases, '-RunsJson', runs,
    '-InstalledVersion', options.installed ?? '1.16.1', '-IdleSeconds', String(options.idle ?? 900)], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: dir } });
  return JSON.parse(out.trim());
}

test('a newer release installs only in a quiet moment', { skip: process.platform !== 'win32' }, async () => {
  const result = await decide({});
  assert.equal(result.action, 'install');
  assert.equal(result.latest, 'v1.17.0');
});

test('the owner at the keyboard or a running tool call defers the install', { skip: process.platform !== 'win32' }, async () => {
  assert.match((await decide({ idle: 20 })).reason, /owner is active/);
  assert.equal((await decide({ idle: 20 })).action, 'wait');
  assert.match((await decide({ running: true })).reason, /tool call is running/);
});

test('nothing happens when current, when switched off, or when no release has a checksum', { skip: process.platform !== 'win32' }, async () => {
  assert.match((await decide({ installed: '1.17.0' })).reason, /already on/);
  assert.match((await decide({ autoUpdate: false })).reason, /switched off/);
  assert.match((await decide({ releases: [{ tag_name: 'v9.0.0', description: 'no checksum', assets: { links: [] } }] })).reason, /no release with an installer/);
});
