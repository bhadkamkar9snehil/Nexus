import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { attachEvents } from './events-extension.js';
import { attachClaudeChannel, CHANNEL_INSTRUCTIONS } from './channel.js';
import { jevClient, toolKey, withToolKey } from './key-routing.js';
import { chooseBoundedWithTypeSafe } from './typescript/jev_adapter.js';
import { parseWindowState } from './typescript/native.js';
import { Driver } from './typescript/run.js';
import { NativeAccessibilitySource } from './typescript/sources.js';
import { selectWindow } from './window-selection.js';
import { restoreWindow } from './restore-window.js';
import { createCoreRegistry } from './tool-handlers/index.js';

const root = join(import.meta.dirname, '..');
const bundledDriver = join(root, 'runtime', 'cua-driver.exe');
const driverExe = existsSync(bundledDriver) ? bundledDriver : join(process.env.LOCALAPPDATA!, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe');
const driverArgs = ['mcp', '--socket', '\\\\.\\pipe\\cua-driver'];
const browser = join(root, 'jev-browse', 'bundled', 'mcp.mjs');

async function warmBrowserEndpoint(profile: string) {
  try {
    const [port, socketPath] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    if (!/^\d{1,5}$/.test(port) || !socketPath?.startsWith('/devtools/browser/')) return '';
    const origin = 'http://127.0.0.1:' + port;
    const response = await fetch(origin + '/json/version', { signal: AbortSignal.timeout(700) });
    if (!response.ok) return '';
    const info = await response.json();
    return info.webSocketDebuggerUrl === 'ws://127.0.0.1:' + port + socketPath ? origin : '';
  } catch {
    return '';
  }
}

async function browserTask(args: object, choice: 'chrome' | 'edge', addUsage: (usage: unknown) => void) {
  const profile = join(root, choice === 'edge' ? 'EdgeProfile' : 'ChromeProfile');
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((path): path is string => Boolean(path))
    .map(path => join(path, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find(existsSync);
  const cdpUrl = await warmBrowserEndpoint(profile);
  if (choice === 'edge' && !edge && !cdpUrl) throw new Error('Microsoft Edge executable was not found');
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', new URL('./browser-usage.mjs', import.meta.url).href, browser], {
      windowsHide: true,
      cwd: root,
      env: { ...process.env, TYPESAFE_API_KEY: toolKey(), JEV_PROFILE: profile, JEV_CDP_URL: cdpUrl, CHROME_PATH: choice === 'edge' ? edge : undefined },
      stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
    });
    const { stdin, stdout } = child;
    if (!stdin || !stdout) {
      child.kill();
      reject(new Error('Browser MCP pipes unavailable'));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Browser task exceeded 120 seconds'));
    }, 120_000);
    child.on('error', reject);
    child.on('message', (message: { usage?: unknown }) => addUsage(message.usage));
    child.on('close', () => {
      clearTimeout(timer);
      reject(new Error('Browser MCP exited before returning a result'));
    });
    const rpc = (message: object) => stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    stdin.on('error', reject);
    createInterface({ input: stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id === 1) {
          rpc({ method: 'notifications/initialized' });
          rpc({ id: 2, method: 'tools/call', params: { name: 'jev_browse', arguments: args } });
        }
        if (message.id === 2) {
          resolve(message.result?.content?.[0]?.text ?? 'Browser MCP returned no result');
          stdin.end();
          if (child.connected) child.disconnect();
        }
      } catch (error) {
        child.kill();
        reject(error);
      }
    });
    rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'shared-jev', version: '1.0.0' } } });
  });
}

async function desktopTask(goal: string, app: string, expect: string, text: string | undefined, limit: number, addUsage: (usage: unknown) => void, windowId?: number, launchAumid?: string) {
  const client = new Client({ name: 'shared-jev', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: driverExe, args: driverArgs, stderr: 'ignore' });
  const trace: string[] = [];
  let calls = 0;
  const started = performance.now();
  const result = (status: string) => JSON.stringify({ status, calls, elapsed_ms: Math.round(performance.now() - started), trace });
  try {
    await client.connect(transport);
    const driver = new Driver(client, 'shared-jev-' + randomUUID());
    const launched = launchAumid ? await driver.call('launch_app', { aumid: launchAumid }) : undefined;
    const windows = launched
      ? (launched.windows ?? []).map((w: any) => ({ ...w, pid: w.pid ?? launched.pid }))
      : (await driver.call('list_windows', {})).windows ?? [];
    let selected = selectWindow(windows, app, windowId);
    if (selected.minimized) {
      // The exact target is minimized: restore it without taking focus and wait until the window manager reports it on screen.
      await restoreWindow(selected.minimized.window_id!);
      trace.push('Restored the minimized window without activating it');
      for (let attempt = 0; attempt < 10 && !selected.window; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        selected = selectWindow((await driver.call('list_windows', {})).windows ?? [], app, windowId);
      }
    }
    if (!selected.window) return result(selected.error ?? 'The minimized window did not restore');
    const { pid, window_id } = selected.window as any;
    const jev = jevClient({ timeout: 8_000, retry: { maxRetries: 0 }, logLevel: 'off' });
    const deadline = performance.now() + 45_000;
    const words = new Set(goal.toLowerCase().match(/[a-z0-9]+/g));
    for (let step = 0; step <= limit; step++) {
      const state = await driver.call('get_window_state', { pid, window_id, full_output: true, include_accessibility_tree: true, include_screenshot: false });
      const observation = parseWindowState(state, pid, window_id);
      if (observation.elements.some((item: any) => [item.name, item.label, item.value].includes(expect))) return result('verified');
      if (step === limit) return result('step limit');
      if (performance.now() > deadline) return result('time limit');
      const source = NativeAccessibilitySource.fromObservation(observation, 'windows');
      const matchesGoal = (label: string) => label.toLowerCase().split(/\W+/).some(word => words.has(word));
      const candidates = source.controls.filter(c => c.risk.size === 0)
        .filter(c => c.roleClass !== 'text_input' || text !== undefined)
        .sort((a, b) => Number(matchesGoal(b.label)) - Number(matchesGoal(a.label)))
        .slice(0, 24).map((c, i) => c.roleClass === 'text_input'
          ? source.typeText(source.control(c), text!, 'a' + i, 'Enter supplied text in ' + c.label)
          : source.click(source.control(c), 'a' + i, 'Click ' + c.label));
      if (!candidates.length) return result('No eligible accessibility actions');
      const criteria = Object.fromEntries(candidates.map(c => [c.id, c.description]));
      criteria.abstain = 'No offered action advances the goal';
      calls++;
      const { selectedId, usage } = await chooseBoundedWithTypeSafe(jev, goal, { prior_actions: trace }, criteria);
      addUsage(usage);
      const action = candidates.find(c => c.id === selectedId);
      if (!action?.tool) return result('abstained');
      await driver.call(action.tool, action.arguments);
      trace.push(action.description);
    }
  } catch (error) {
    return result(error instanceof Error ? error.name + ('code' in error ? ' ' + error.code : '') : 'error');
  } finally {
    await transport.close();
  }
  return result('step limit');
}

function createServer() {
const registry = createCoreRegistry();
const server = new Server({ name: 'shared-jev', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: CHANNEL_INSTRUCTIONS });
attachEvents(server, root);
attachClaudeChannel(server, root);
server.setRequestHandler('tools/list', async () => ({ tools: registry.list() }));
server.setRequestHandler('tools/call', async ({ params }) => withToolKey(params.name, async () => {
  const id = randomUUID();
  const started = Date.now();
  const monitored = registry.has(params.name) && !(['search_status','list_sessions'].includes(params.name) && process.env.HARNESS_MONITOR_OBSERVATION === '1');
  let inputTokens = 0, outputTokens = 0, usageResponses = 0;
  const addUsage = (value: unknown) => {
    const usage = value as { input_tokens?: number; output_tokens?: number } | undefined;
    if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number' ||
        !Number.isSafeInteger(usage.input_tokens) || !Number.isSafeInteger(usage.output_tokens) ||
        usage.input_tokens < 0 || usage.output_tokens < 0) return;
    inputTokens += usage.input_tokens;
    outputTokens += usage.output_tokens;
    usageResponses++;
  };
  const usageMetrics = (decisions?: number) => usageResponses || decisions === 0 ? {
    inputTokens, outputTokens, usageResponses,
    estimatedJevUsd: inputTokens * 0.042 / 1_000_000,
    usagePartial: decisions === undefined || decisions > usageResponses,
  } : {};
  const record = (details: object) => {
    if (!monitored) return;
    try {
      appendFileSync(join(root, 'runs.jsonl'), JSON.stringify({ id, tool: params.name, at: Date.now(), ...details }) + '\n');
    } catch {
      console.error('Could not write SharedJev monitoring event');
    }
  };
  record({ status: 'running' });
  try {
    const args = params.arguments ?? {};
    const required = (key: string, maxLength = 2000) => {
      const value = args[key];
      if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error('Invalid ' + key);
      return value;
    };
    const limit = args.max_steps ?? 10;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid max_steps');
    const decisionTool = ['jev_select_workflow','jev_rank_results','jev_classify_failure','jev_verify_result'].includes(params.name);
    const goal = decisionTool || ['web_scrape', 'browser_read_page', 'jev_search_content', 'search_local', 'nexus_read_file', 'nexus_read_document', 'nexus_write_file','nexus_edit_file', 'network_probe', 'find_files', 'search_status', 'map_files', 'start_process', 'read_process_output', 'interact_with_process', 'list_sessions', 'force_terminate', 'list_processes', 'kill_process', 'restart_application', 'restart_status', 'nexus_peers', 'nexus_mail', 'nexus_webhooks', 'nexus_events'].includes(params.name) ? '' : required('goal');
    const output = await registry.execute(params.name, { name: params.name, args, required, limit, goal, addUsage, root, browserTask, desktopTask });
    let metrics;
    try { metrics = JSON.parse(output); } catch { metrics = {}; }
    const status = metrics.status === 'done' || metrics.status === 'verified' || (params.name === 'search_status' && metrics.status === 'idle') ? 'passed'
      : metrics.status && metrics.status !== 'error' ? 'blocked' : 'error';
    const decisions = metrics.decisions ?? metrics.calls;
    record({ status, ms: Date.now() - started, decisions: decisions ?? null, steps: metrics.steps ?? metrics.trace?.length ?? null, backend: metrics.backend ?? null, session: metrics.session_id ?? metrics.session ?? null, ...usageMetrics(decisions) });
    return { content: [{ type: 'text', text: output }] };
  } catch (error) {
    record({ status: 'error', ms: Date.now() - started, ...usageMetrics() });
    return { isError: true, content: [{ type: 'text', text: String(error) }] };
  }
}));
return server;
}
serveStdio(() => createServer());
