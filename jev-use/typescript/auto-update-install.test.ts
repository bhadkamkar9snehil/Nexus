import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const updater = join(import.meta.dirname, '..', '..', 'Update-Nexus.ps1');

async function runInstallerScenario(exitCode: number, installedVersion: string, launchFailure = false, monitor: 'healthy' | 'missing' | 'wrong-root' = 'healthy') {
  const home = await mkdtemp(join(tmpdir(), 'nexus-updater-exit-'));
  try {
    const mock = [
      'function Start-Process {',
      '  param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)',
      "  if ($env:NEXUS_TEST_LAUNCH_FAIL -eq '1') { throw 'Simulated process start failure' }",
      "  Set-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'Nexus\\installer-args.txt') -Value ($ArgumentList -join [char]10)",
      '  [pscustomobject]@{ ExitCode = [int]$env:NEXUS_TEST_EXIT }',
      '}',
      'function Get-ItemProperty {',
      '  param([string]$Path, [string]$ErrorAction)',
      "  [pscustomobject]@{ DisplayVersion = $env:NEXUS_TEST_INSTALLED; InstallLocation = 'C:\\Fixture\\Nexus' }",
      '}',
      'function Get-ScheduledTask {',
      '  param([string]$TaskName, [string]$ErrorAction)',
      "  if ($env:NEXUS_TEST_MONITOR -eq 'missing') { return $null }",
      "  [pscustomobject]@{ State = 'Running' }",
      '}',
      'function Invoke-RestMethod {',
      '  param([string]$Uri, [int]$TimeoutSec)',
      "  $path = if ($env:NEXUS_TEST_MONITOR -eq 'wrong-root') { 'C:\\Other\\Nexus' } else { 'C:\\Fixture\\Nexus' }",
      "  [pscustomobject]@{ application='shared-computer-use-monitor'; managed=$true; root=$path }",
      '}',
      'function Start-Sleep { param([int]$Seconds) }',
      'function Unregister-ScheduledTask {',
      '  param([string]$TaskName, [switch]$Confirm, [string]$ErrorAction)',
      "  Write-Output 'SIMULATED_TASK_CLEANUP'",
      '}',
      '& $env:NEXUS_TEST_SCRIPT -Install -File $env:ComSpec -Version v1.18.0',
      'exit $LASTEXITCODE',
    ].join('\n');
    const wrapper = join(home, 'mock-updater.ps1');
    await writeFile(wrapper, mock, 'utf8');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper,
    ], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env, LOCALAPPDATA: home,
        NEXUS_TEST_SCRIPT: updater,
        NEXUS_TEST_EXIT: String(exitCode),
        NEXUS_TEST_INSTALLED: installedVersion,
        NEXUS_TEST_LAUNCH_FAIL: launchFailure ? '1' : '0',
        NEXUS_TEST_MONITOR: monitor,
      },
    });
    assert.equal(result.error, undefined);
    const log = await readFile(join(home, 'Nexus', 'auto-update.log'), 'utf8');
    assert.match(result.stdout, /SIMULATED_TASK_CLEANUP/);
    const receipt = JSON.parse(await readFile(join(home, 'Nexus', 'last-install-receipt.json'), 'utf8'));
    const args = await readFile(join(home, 'Nexus', 'installer-args.txt'), 'utf8').catch(() => '');
    return { code: result.status, log, stderr: result.stderr, receipt, args };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('failed curl host does not prevent trying the next release download source', { skip: process.platform !== 'win32' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'nexus-curl-fallback-'));
  try {
    const wrapper = join(temp, 'curl-fallback-test.ps1');
    await writeFile(wrapper, [
      '. $env:NEXUS_TEST_SCRIPT -FunctionsOnly',
      "$ErrorActionPreference = 'Stop'",
      "$failed = Invoke-NexusCurl -Arguments @('-fsS','--connect-timeout','1','--max-time','2','http://127.0.0.1:1/nexus-invalid')",
      "if ($failed) { throw 'Unreachable first host unexpectedly succeeded' }",
      "$url = ([uri]$env:ComSpec).AbsoluteUri",
      "$second = Invoke-NexusCurl -Arguments @('-fsS','--max-time','3','-o','NUL',$url)",
      "if (-not $second) { throw 'Second source did not run' }",
      "Write-Output 'CURL_FALLBACK_OK'",
    ].join('\n'), 'utf8');
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper], {
      encoding: 'utf8', timeout: 15000, env: { ...process.env, LOCALAPPDATA: temp, NEXUS_TEST_SCRIPT: updater },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CURL_FALLBACK_OK/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('silent updater returns a nonzero installer failure and does not claim success', { skip: process.platform !== 'win32' }, async () => {
  const result = await runInstallerScenario(5, '1.17.1');
  assert.equal(result.code, 5, result.stderr + '\n' + result.log);
  assert.match(result.log, /Installer finished with exit code 5/);
  assert.equal(result.receipt.exitCode, 5);
  assert.equal(result.receipt.monitorVerified, false);
  assert.match(result.args, /\/LOG=/);
  assert.doesNotMatch(result.log, /Installed Nexus version verified/);
});

test('silent updater succeeds only after the installed version matches', { skip: process.platform !== 'win32' }, async () => {
  const result = await runInstallerScenario(0, '1.18.0');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.log, /Installed Nexus version and running managed monitor verified: 1\.18\.0/);
  assert.equal(result.receipt.exitCode, 0);
  assert.equal(result.receipt.monitorVerified, true);
  assert.match(result.args, /\/LOG=/);
  assert.match(result.receipt.installerLog, /installer-1\.18\.0-/);
});

test('silent updater rejects installer exit zero with stale registered version', { skip: process.platform !== 'win32' }, async () => {
  const result = await runInstallerScenario(0, '1.17.1');
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.log, /installed version was not verified/);
  assert.equal(result.receipt.exitCode, 1);
});

test('silent updater reports installer start errors without leaving a false success', { skip: process.platform !== 'win32' }, async () => {
  const result = await runInstallerScenario(0, '1.17.1', true);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.log, /Installer execution failed/);
  assert.equal(result.receipt.exitCode, 1);
});

test('silent updater fails if setup exits zero but monitor task is absent', { skip: process.platform !== 'win32' }, async () => {
  const result = await runInstallerScenario(0, '1.18.0', false, 'missing');
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.receipt.monitorVerified, false);
  assert.match(result.log, /managed Nexus monitor or its scheduled task is not healthy/);
});

test('silent updater fails if monitor belongs to a different installation', { skip: process.platform !== 'win32' }, async () => {
  const result = await runInstallerScenario(0, '1.18.0', false, 'wrong-root');
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.receipt.monitorVerified, false);
});
