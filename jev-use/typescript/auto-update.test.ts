import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dirname, '..', '..', 'Update-Nexus.ps1');
const sha = 'a'.repeat(64);
const release = (tag: string) => ({ tag_name: tag, description: `## Checksums\n- Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe: SHA256 ${sha}`,
  assets: { links: [{ name: `Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe`, url: `http://10.2.6.112:8080/api/v4/projects/55/packages/generic/nexus-harness/${tag.slice(1)}/Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe` }] } });
const githubRelease = (tag: string, digest = `sha256:${sha}`) => ({
  tag_name: tag, body: `## Checksums\n- Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe: SHA256 ${sha}`,
  assets: [{ name: `Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe`,
    browser_download_url: `https://github.com/bhadkamkar9snehil/Nexus/releases/download/${tag}/Nexus-Harness-Setup-${tag.slice(1)}-windows-x64.exe`, digest }],
});

async function decide(options: { installed?: string; idle?: number; running?: boolean; installerRunning?: boolean; autoUpdate?: boolean; releases?: unknown[] }) {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-auto-update-'));
  await mkdir(join(dir, 'Nexus'), { recursive: true });
  if (options.autoUpdate === false) await writeFile(join(dir, 'Nexus', 'updates.json'), '{"autoUpdate":false}');
  const releases = join(dir, 'releases.json');
  await writeFile(releases, JSON.stringify(options.releases ?? [release('v1.17.0'), release('v1.16.1')]));
  const runs = join(dir, 'runs.json');
  await writeFile(runs, JSON.stringify(options.running ? [{ status: 'running', started: Date.now() - 5000 }] : [{ status: 'passed', started: Date.now() - 600000 }]));
  const wrapper = join(dir, 'fixture.ps1');
  await writeFile(wrapper, [
    "function Get-Process { if ($env:NEXUS_TEST_INSTALLER_RUNNING -eq '1') { [pscustomobject]@{ Name = 'Nexus-Harness-Setup-fixture' } } }",
    '& $env:NEXUS_TEST_UPDATER @args',
    'exit $LASTEXITCODE',
  ].join('\n'));
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-DryRun', '-ReleasesJson', releases, '-RunsJson', runs,
    '-InstalledVersion', options.installed ?? '1.16.1', '-IdleSeconds', String(options.idle ?? 900)], {
    encoding: 'utf8',
    env: { ...process.env, LOCALAPPDATA: dir, NEXUS_TEST_UPDATER: script, NEXUS_TEST_INSTALLER_RUNNING: options.installerRunning ? '1' : '0' },
  });
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
  assert.match((await decide({ installerRunning: true })).reason, /installer is already running/);
});

test('public GitHub release is eligible without private GitLab credentials', { skip: process.platform !== 'win32' }, async () => {
  const result = await decide({ installed: '1.17.1', releases: [githubRelease('v1.18.0')] });
  assert.equal(result.action, 'install');
  assert.equal(result.latest, 'v1.18.0');
});

test('highest version across GitHub and GitLab is selected regardless of order', { skip: process.platform !== 'win32' }, async () => {
  const result = await decide({ installed: '1.17.0', releases: [githubRelease('v1.18.0'), release('v1.19.0')] });
  assert.equal(result.action, 'install');
  assert.equal(result.latest, 'v1.19.0');
});

test('GitHub release is refused when published digest disagrees with description', { skip: process.platform !== 'win32' }, async () => {
  const result = await decide({ installed: '1.17.1', releases: [githubRelease('v1.18.0', 'sha256:' + 'b'.repeat(64))] });
  assert.equal(result.action, 'none');
  assert.match(result.reason, /no release with an installer/);
});

test('nothing happens when current, when switched off, or when no release has a checksum', { skip: process.platform !== 'win32' }, async () => {
  assert.match((await decide({ installed: '1.17.0' })).reason, /already on/);
  assert.match((await decide({ autoUpdate: false })).reason, /switched off/);
  assert.match((await decide({ releases: [{ tag_name: 'v9.0.0', description: 'no checksum', assets: { links: [] } }] })).reason, /no release with an installer/);
});

test('a denied schedule never starts the existing updater task', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-update-schedule-'));
  const staged = join(dir, 'Nexus', 'staged');
  await mkdir(staged, { recursive: true });
  const bytes = 'verified installer fixture';
  const filename = 'Nexus-Harness-Setup-1.17.0-windows-x64.exe';
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(staged, filename), bytes);
  const fixture = release('v1.17.0');
  fixture.description = fixture.description.replace(sha, checksum);
  await writeFile(join(dir, 'releases.json'), JSON.stringify([fixture]));
  await writeFile(join(dir, 'runs.json'), '[]');
  const wrapper = join(dir, 'wrapper.ps1');
  await writeFile(wrapper, [
    `function Get-FileHash { [pscustomobject]@{ Hash = '${checksum}' } }`,
    'function New-ScheduledTaskAction {}',
    'function New-ScheduledTaskPrincipal {}',
    'function Get-Process {}',
    "function Register-ScheduledTask { Write-Error 'simulated access denied' -ErrorAction Continue }",
    "function Start-ScheduledTask { Write-Output 'STALE_TASK_STARTED' }",
    "& $env:NEXUS_TEST_UPDATER -ReleasesJson (Join-Path $env:LOCALAPPDATA 'releases.json') -RunsJson (Join-Path $env:LOCALAPPDATA 'runs.json') -InstalledVersion '1.16.1' -IdleSeconds 900",
    'exit $LASTEXITCODE',
  ].join('\n'));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: dir, NEXUS_TEST_UPDATER: script },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /simulated access denied/);
  assert.doesNotMatch(result.stdout, /STALE_TASK_STARTED/);
});

test('scheduling does not request Highest run level when caller is not elevated', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-update-runlevel-'));
  const staged = join(dir, 'Nexus', 'staged');
  await mkdir(staged, { recursive: true });
  const bytes = 'verified installer fixture';
  const filename = 'Nexus-Harness-Setup-1.17.0-windows-x64.exe';
  const checksum = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(staged, filename), bytes);
  const fixture = release('v1.17.0');
  fixture.description = fixture.description.replace(sha, checksum);
  await writeFile(join(dir, 'releases.json'), JSON.stringify([fixture]));
  await writeFile(join(dir, 'runs.json'), '[]');
  const wrapper = join(dir, 'wrapper.ps1');
  await writeFile(wrapper, [
    `function Get-FileHash { [pscustomobject]@{ Hash = '${checksum}' } }`,
    'function New-ScheduledTaskAction { [pscustomobject]@{ Arguments = $args[3] } }',
    'function New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) [Console]::Out.WriteLine("RUNLEVEL=$RunLevel"); [pscustomobject]@{ RunLevel = $RunLevel } }',
    'function Get-Process {}',
    'function Register-ScheduledTask { param($TaskName, $Action, $Principal) [pscustomobject]@{ Actions = @([pscustomobject]@{ Arguments = $Action.Arguments }) } }',
    'function Start-ScheduledTask {}',
    "& $env:NEXUS_TEST_UPDATER -ReleasesJson (Join-Path $env:LOCALAPPDATA 'releases.json') -RunsJson (Join-Path $env:LOCALAPPDATA 'runs.json') -InstalledVersion '1.16.1' -IdleSeconds 900",
    'exit $LASTEXITCODE',
  ].join('\n'));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: dir, NEXUS_TEST_UPDATER: script },
  });
  assert.equal(result.status, 0);
  const isAdmin = spawnSync('powershell.exe', ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { encoding: 'utf8' }).stdout.trim() === 'True';
  assert.match(result.stdout, isAdmin ? /RUNLEVEL=Highest/ : /RUNLEVEL=\r?\n/);
});
