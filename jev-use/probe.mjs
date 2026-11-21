import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { join } from 'node:path';
import { createServer } from 'node:http';

const browser = process.argv[2] === 'browser';
const desktop = process.argv[2] === 'desktop';
const search = process.argv[2] === 'search';
const files = process.argv[2] === 'files';
const cua = !browser && !desktop && !search && !files;
const driver = join(process.env.LOCALAPPDATA, 'Programs', 'Cua', 'cua-driver', 'bin', 'cua-driver.exe');
const transport = new StdioClientTransport({
  command: cua ? driver : process.execPath,
  args: cua ? ['mcp', '--socket', String.raw`\\.\pipe\cua-driver`] : [join(import.meta.dirname, 'start.mjs')],
  env: process.env,
  stderr: 'ignore',
});
const client = new Client({ name: 'shared-jev-diagnostic', version: '1.0.0' });
async function check(name, args, summarize) {
  const start = performance.now();
  try {
    const response = await client.callTool({ name, arguments: args }, { timeout: 135_000 });
    const detail = response.isError ? response.content : summarize(response.structuredContent ?? response.content);
    console.log(JSON.stringify({ tool: name, ms: Math.round(performance.now() - start), error: Boolean(response.isError), detail }));
  } catch (error) {
    console.log(JSON.stringify({ tool: name, ms: Math.round(performance.now() - start), error: String(error) }));
  }
}
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(JSON.stringify({ server: client.getServerVersion(), tools: tools.length }));
  if (browser) {
    const fixture = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Form check</title><form>
        <label>Name<input id="person"></label>
        <label><input type="checkbox" id="blue"> Blue</label>
        <label><input type="checkbox" id="green"> Green</label>
        <button type="button" onclick="if(blue.checked && green.checked && (!location.search || person.value==='Harness test')) result.textContent='Both colors confirmed'">Confirm</button>
        <p id="result"></p></form>`);
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    try {
      await check('jev_browse', {
        url: 'http://127.0.0.1:' + fixture.address().port + (process.argv[4] === 'playwright' ? '?text=1' : ''),
        goal: process.argv[4] === 'playwright' ? 'Fill Name using the supplied value, check both Blue and Green, then click Confirm and verify the result' : 'Check both Blue and Green, then click Confirm and verify the result',
        ...(process.argv[4] === 'playwright' ? { backend: 'playwright', session: 'smoke', fields: { Name: 'Harness test' } } : {}),
        expect_text: 'Both colors confirmed', max_steps: 8, browser: process.argv[3] ?? 'chrome',
      }, x => {
        const r = JSON.parse(x[0].text);
        return { status: r.status, decisions: r.decisions, steps: r.steps, backend: r.backend, session: r.session, reused: r.reused, blocked: r.blocked_cause };
      });
    } finally {
      fixture.close();
    }
  } else if (files) {
    await check('search_status', {}, x => {
      const result = JSON.parse(x[0].text);
      if (!result.running || !result.drives?.length) throw new Error('Search index not ready');
      return { status: result.status, records: result.records, workingSetBytes: result.workingSetBytes, readingViaBroker: result.readingViaBroker };
    });
    await check('find_files', { pattern: 'shared-computer-use', drive: 'C', kind: 'folder', limit: 5 }, x => {
      const result = JSON.parse(x[0].text);
      if (!result.matches?.some(row => row.name === 'shared-computer-use' && row.isDirectory)) throw new Error('Expected folder was not found');
      return { status: result.status, matches: result.matches.length, search_ms: result.search_ms, decisions: result.decisions, limited: result.limited };
    });
    await check('find_files', { pattern: 'shared-computer-use', drive: 'C', kind: 'file', limit: 5, query: 'Find the v1.1.0 release ZIP for the shared harness' }, x => {
      const result = JSON.parse(x[0].text);
      if (!result.best?.name?.includes('v1.1.0.zip')) throw new Error('Jev did not select the expected ZIP');
      return { status: result.status, best: result.best.path, search_ms: result.search_ms, decisions: result.decisions };
    });
  } else if (search) {
    await check('jev_search_content', { root: join(import.meta.dirname, '..'), pattern: 'DPAPI', query: 'How does the harness store a teammate API key?' }, x => {
      const result = JSON.parse(x[0].text);
      if (result.status !== 'done' || !result.best) throw new Error('Search did not identify evidence');
      return { status: result.status, bestPath: result.best.path, line: result.best.line, decisions: result.decisions, truncated: result.truncated };
    });
  } else if (desktop) {
    const target = process.argv[3] === 'launch' ? { launch_aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }
      : process.argv[3] ? { window_id: Number(process.argv[3]) } : {};
    await check('jev_desktop', { app: 'Calculator', ...target, goal: 'Click the Seven button to enter seven. If the display already has a digit, click Clear first.', expect: 'Display is 7', max_steps: 5 }, x => x);
  } else {
    await check('list_apps', {}, x => ({ count: x.apps?.length }));
    const { structuredContent } = await client.callTool({ name: 'list_windows', arguments: {} });
    const windows = structuredContent?.windows ?? [];
    console.log(JSON.stringify({ tool: 'list_windows', count: windows.length }));
    const calc = windows.find(w => w.title === 'Calculator' && !w.minimized);
    const explorer = windows.find(w => w.title === 'SharedJev' && !w.minimized);
    for (const w of [calc, explorer].filter(Boolean)) {
      await check('get_window_state', { pid: w.pid, window_id: w.window_id, include_screenshot: w === calc, full_output: true }, x => ({
        title: w.title, elements: x.elements?.length, screenshot: Boolean(x.screenshot || x.capture_id),
        labels: (x.tree_markdown ?? '').split('\n').filter(line => /clear|plus|equals|jev-browse|jev-use|result|two|three/i.test(line)).slice(0, 14),
      }));
    }
    if (calc) {
      const target = { pid: calc.pid, window_id: calc.window_id };
      await check('run_steps', { ...target, delivery_mode: 'background', steps: ['Clear', 'Two', 'Plus', 'Three', 'Equals'].map(name => ({ click: { role: 'button', name } })) }, x => x);
      await check('run_script', { script: `const app = await cua.getApp({pid:${calc.pid},windowId:${calc.window_id}}); const state = await app.getState({include_screenshot:false}); if (!state.tree_markdown) return {found:false}; return {found: state.tree_markdown.includes('Display is 5')};` }, x => x);
    }
  }
} finally {
  await transport.close();
}
