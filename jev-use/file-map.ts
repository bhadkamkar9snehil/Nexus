// map_files tool: UFFS list -> units (folders / loose files) -> content samples -> Jev project choice -> map + treemap.
// Read-only: never moves, renames or deletes files.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, fstatSync, readdirSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { choice } from '@typesafe-ai/sdk';
import { jevClient } from './key-routing.js';
import { uffsExecutable } from './find-files.js';

type Row = { path: string; size: number; modified: number };
type Unit = { unit: string; n: number; bytes: number; ext: Record<string, number>; files: string[]; paths: string[]; loose: boolean };
type Verdict = { project: string; confidence: number };

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '$RECYCLE.BIN', '.gradle', 'bin', 'obj']);
const TEXT = new Set(['.txt', '.md', '.sql', '.csv', '.json', '.xml', '.html', '.htm', '.py', '.ps1', '.cs', '.js', '.ts', '.log', '.yml', '.yaml', '.ini', '.cfg']);
const OOXML: Record<string, string> = { '.docx': 'word/document.xml', '.xlsx': 'xl/sharedStrings.xml', '.pptx': 'ppt/slides/slide1.xml' };

// Editable: write the same shape to <out_dir>\projects.json to override.
export const DEFAULT_PROJECTS: Record<string, string> = {
  'XStudio-Platform': 'The XStudio/XMES platform itself: its installers, XS Builder, platform docs, SQL, HTML controls. NOT client work that merely runs on XStudio.',
  Historian: 'AVEVA/Wonderware Historian work, Sohar Steel publish and backups',
  'IOCL-PLHO': 'IOCL PLHO Noida to Bangalore cutover, SQL and app servers',
  Pidilite: 'Pidilite batch mistake-proofing recipe',
  'EMAMI-MES': 'Emami MES project',
  APS: 'APS planning/scheduling product and UI references',
  ACM: 'ACM application versions, data and results',
  Simulator: 'Tag / industrial data simulators',
  Dangote: 'Dangote bid and documents',
  BPCL: 'BPCL pipelines demo',
  'JK-Paper': 'JK Paper printer camera project',
  Training: 'Training material and reference books',
  Storyboard: 'Storyboard product',
  'Grafana-Monitoring': 'Grafana, Prometheus, Telegraf, InfluxDB, MonitorIt, monitoring migration',
  'NiFi-Data': 'Apache NiFi and data-flow tooling',
  'Proxmox-Lab': 'Proxmox lab VMs, Ubuntu, HA, infrastructure',
  GitLab: 'GitLab server, CI, repositories',
  EOS: 'Employee Operating System',
  'AI-Helpdesk': 'AI helpdesk / Chitragupta / gbrain',
  'QMS-Salesforce': 'QMS and Salesforce',
  'Harness-Tools': 'Agent harness, Codex, Claude, Jev, computer-use tooling',
  Installers: 'Generic software installers and ISOs not tied to a project',
  Personal: 'Personal, finance, photos, non-work documents',
  Review: 'Cannot tell from name or content; needs a human look',
};

function listFiles(root: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(uffsExecutable(), ['*', '--drive', root[0], '--files-only', '--in-path', root, '--format', 'json'], { windowsHide: true });
    const rows: Row[] = [];
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const r = JSON.parse(line);
        if (typeof r.path !== 'string' || r.path.indexOf(':', 2) !== -1) return; // skip NTFS streams (:Zone.Identifier)
        if (r.path.split('\\').some((p: string) => SKIP.has(p))) return;
        rows.push({ path: r.path, size: r.size ?? 0, modified: Math.round((r.modified / 10000 - 11644473600000)) });
      } catch { /* not a data row */ }
    });
    child.on('error', () => reject(new Error('UFFS search unavailable. Check uffs --daemon status. No recursive fallback was run.')));
    child.on('close', code => (code === 0 || rows.length ? resolve(rows) : reject(new Error('UFFS search failed'))));
  });
}

function unitOf(path: string, home: string): { key: string; loose: boolean } {
  const rel = path.slice(home.length + 1).split('\\');
  const rootLen = rel[0] === 'Documents' && (rel[1] === 'Office' || rel[1] === 'Personal') ? 2 : 1;
  const folders = rel.slice(0, -1);
  if (folders.length <= rootLen) return { key: rel.join('\\'), loose: true };
  return { key: folders.slice(0, rootLen + 2).join('\\'), loose: false };
}

function zipEntry(file: string, name: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 66000)); readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return '';
    const cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize); readSync(fd, cd, 0, cdSize, cdOff);
    for (let p = 0; p + 46 <= cd.length;) {
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), lho = cd.readUInt32LE(p + 42);
      if (cd.toString('utf8', p + 46, p + 46 + nlen) === name) {
        const lh = Buffer.alloc(30); readSync(fd, lh, 0, 30, lho);
        const data = Buffer.alloc(Math.min(csize, 40000)); readSync(fd, data, 0, data.length, lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
        return (method === 0 ? data : inflateRawSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH: partial input ok */ })).toString('utf8').replace(/<[^>]+>/g, ' ');
      }
      p += 46 + nlen + elen + clen;
    }
  } catch { /* unreadable: no sample */ } finally { closeSync(fd); }
  return '';
}

function sample(path: string, size: number): string {
  const ext = extname(path).toLowerCase();
  try {
    if (size > 5_000_000 && !OOXML[ext]) return '';
    let text = '';
    if (TEXT.has(ext)) { const fd = openSync(path, 'r'); const b = Buffer.alloc(800); const n = readSync(fd, b, 0, 800, 0); closeSync(fd); text = b.toString('utf8', 0, n); }
    else if (OOXML[ext]) text = zipEntry(path, OOXML[ext]);
    return text.replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch { return ''; }
}

async function classify(units: Unit[], projects: Record<string, string>, samples: Map<string, string[]>, log: (s: string) => void, addUsage: (u: unknown) => void) {
  const client = jevClient({ timeout: 60_000, retry: { maxRetries: 2 }, logLevel: 'off' });
  const out = new Map<string, Verdict>();
  const BATCH = 10, PAR = 4;
  const batches: Unit[][] = []; for (let i = 0; i < units.length; i += BATCH) batches.push(units.slice(i, i + BATCH));
  let next = 0, done = 0;
  const describe = (u: Unit, i: number) => u.loose
    ? { id: 'q' + i, file: u.unit, mb: +(u.bytes / 2 ** 20).toFixed(1), content: samples.get(u.unit)?.[0] ?? '' }
    : { id: 'q' + i, folder: u.unit, files: u.n, gb: +(u.bytes / 2 ** 30).toFixed(2), exts: u.ext, names: u.files, content: samples.get(u.unit) ?? [] };
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const questions: Record<string, ReturnType<typeof choice>> = {};
      b.forEach((u, i) => { questions['q' + i] = choice(`Which project does item "q${i}" (${u.unit.split('\\').pop()}) belong to? XStudio is a platform used by many projects: pick the client/project the material serves, and use XStudio-Platform only for the platform's own files. Judge by name, extension and content samples of that item only.`, projects); });
      try {
        const r = await client.systemOne({ state: { items: JSON.stringify(b.map(describe)) }, questions });
        addUsage(r.usage);
        b.forEach((u, i) => { const a = r.answers['q' + i]; out.set(u.unit, a.type === 'choice' ? { project: a.choice, confidence: a.confidence } : { project: 'Review', confidence: 0 }); });
      } catch { b.forEach(u => out.set(u.unit, { project: 'Review', confidence: 0 })); }
      if (++done % 20 === 0) log(`${done}/${batches.length} batches`);
    }
  }));
  return out;
}

type Node = { b: number; n: number; low: number; dup: number; cs: number; mx: number; cat: Record<string, number>; k: Map<string, Node> };
const CATS: [RegExp, string][] = [[/\.(docx?|pdf|txt|md|pptx?)$/i, 'documents'], [/\.(xlsx?|csv)$/i, 'spreadsheets'], [/\.(png|jpe?g|gif|svg|webp|mp4|mov)$/i, 'media'], [/\.(zip|7z|rar|tar|gz|iso)$/i, 'archives/ISOs'], [/\.(exe|msi|msix)$/i, 'installers'], [/\.(sql|bak|mdf|ldf|db)$/i, 'databases'], [/\.(py|ps1|cs|js|ts|json|xml|html|ya?ml|dll|pdb)$/i, 'code/config']];
const catOf = (path: string) => CATS.find(([rx]) => rx.test(path))?.[1] ?? 'other';
function treemapHtml(rows: { path: string; size: number; modified: number; project: string; confidence: number }[], home: string): string {
  const mk = (): Node => ({ b: 0, n: 0, low: 0, dup: 0, cs: 0, mx: 0, cat: {}, k: new Map() });
  const root = new Map<string, Node>();
  // duplicate = same file name and size (>= 1 MB, not .dll/.pdb app noise) seen more than once; every copy is marked
  const seen = new Map<string, number>();
  const dupKey = (r: { path: string; size: number }) => (r.size >= 2 ** 20 && !/\.(dll|pdb)$/i.test(r.path) ? r.path.split('\\').pop() + '|' + r.size : '');
  for (const r of rows) { const k = dupKey(r); if (k) seen.set(k, (seen.get(k) ?? 0) + 1); }
  for (const r of rows) {
    const low = r.project === 'Review' || r.confidence < 0.6 ? 1 : 0;
    const all = r.path.slice(home.length + 1).split('\\'); const file = all.pop()!;
    const parts = all.length > 1 ? [all[0] + '\\' + all[1], ...all.slice(2)] : all; // "Downloads\X" is one node, not two
    let n = root.get(r.project) ?? mk(); root.set(r.project, n);
    const chain = [n];
    for (const p of parts.slice(0, 4)) { let c = n.k.get(p); if (!c) { c = mk(); n.k.set(p, c); } n = c; chain.push(n); }
    if (r.size >= 100 * 2 ** 20) { const leaf = mk(); n.k.set(file, leaf); chain.push(leaf); }
    const dup = (seen.get(dupKey(r)) ?? 0) > 1 ? r.size : 0;
    const cat = catOf(r.path);
    for (const c of chain) { c.b += r.size; c.n++; c.low += low; c.dup += dup; c.cs += r.confidence; c.mx = Math.max(c.mx, r.modified); c.cat[cat] = (c.cat[cat] ?? 0) + r.size; }
  }
  const conv = (name: string, n: Node): Record<string, unknown> => {
    const kept = [...n.k].filter(([, v]) => v.b >= 2 ** 20).map(([k, v]) => conv(k, v));
    const rest = n.b - [...n.k.values()].filter(v => v.b >= 2 ** 20).reduce((s, v) => s + v.b, 0);
    const d: Record<string, unknown> = { name, n: n.n, b: n.b, low: n.low, dup: n.dup, conf: +(n.cs / n.n).toFixed(3), mx: n.mx, cat: Object.entries(n.cat).sort((a, b) => b[1] - a[1])[0]?.[0] };
    if (kept.length) { if (rest > 0) kept.push({ name: '(small files)', value: rest, n: 0, low: 0 }); d.children = kept; } else d.value = n.b;
    return d;
  };
  const data = { name: 'All', children: [...root].map(([p, n]) => conv(p, n)) };
  return readFileSync(join(import.meta.dirname, 'file-map-treemap.html'), 'utf8').replace('__DATA__', () => JSON.stringify(data));
}

export async function mapFiles(opts: { action: 'build' | 'view'; roots: string[]; outDir: string; limitUnits?: number; open: boolean }, addUsage: (u: unknown) => void) {
  const started = Date.now();
  const home = homedir();
  mkdirSync(opts.outDir, { recursive: true });
  const jsonl = join(opts.outDir, 'map.jsonl'), htmlPath = join(opts.outDir, 'treemap.html');
  let rows: { path: string; size: number; modified: number; project: string; confidence: number }[];
  let summary: Record<string, { files: number; gb: number }> = {};
  let unitCount = 0;
  if (opts.action === 'view') {
    if (!existsSync(jsonl)) throw new Error('No map yet; run map_files with action build first');
    rows = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } else {
    const files = (await Promise.all(opts.roots.map(listFiles))).flat();
    const unitMap = new Map<string, Unit>();
    for (const f of files) {
      const { key, loose } = unitOf(f.path, home);
      let u = unitMap.get(key); if (!u) { u = { unit: key, n: 0, bytes: 0, ext: {}, files: [], paths: [], loose }; unitMap.set(key, u); }
      u.n++; u.bytes += f.size; const e = extname(f.path).toLowerCase(); u.ext[e] = (u.ext[e] ?? 0) + 1;
      if (u.files.length < 10) u.files.push(f.path.split('\\').pop()!);
      if (u.paths.length < 40) u.paths.push(f.path);
    }
    let units = [...unitMap.values()];
    unitCount = units.length;
    if (opts.limitUnits) units = units.slice(0, opts.limitUnits);
    const sizes = new Map(files.map(f => [f.path, f.size]));
    const samples = new Map<string, string[]>();
    for (const u of units) { // up to 5 content samples per unit, preferring readable types
      const readable = u.paths.filter(p => TEXT.has(extname(p).toLowerCase()) || OOXML[extname(p).toLowerCase()]).slice(0, 5);
      samples.set(u.unit, readable.map(p => sample(p, sizes.get(p) ?? 0)).filter(Boolean));
    }
    const projectsFile = join(opts.outDir, 'projects.json');
    const projects = existsSync(projectsFile) ? JSON.parse(readFileSync(projectsFile, 'utf8')) : DEFAULT_PROJECTS;
    const verdicts = await classify(units, projects, samples, () => {}, addUsage);
    rows = files.map(f => { const v = verdicts.get(unitOf(f.path, home).key) ?? { project: 'Review', confidence: 0 }; return { ...f, ...v }; });
  }
  // Decisions made in review.html (overrides*.json, saved to out_dir or Downloads) win over Jev and persist across rebuilds.
  const ovPath = join(opts.outDir, 'overrides.json');
  const found = [ovPath, ...(existsSync(join(home, 'Downloads')) ? readdirSync(join(home, 'Downloads')).filter(f => /^overrides.*\.json$/i.test(f)).map(f => join(home, 'Downloads', f)) : [])]
    .filter(existsSync).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  const ov: Record<string, string> = {};
  for (const f of found) try { Object.assign(ov, JSON.parse(readFileSync(f, 'utf8'))); } catch { /* ignore a bad file */ }
  let overridden = 0;
  if (found.length) {
    writeFileSync(ovPath, JSON.stringify(ov, null, 1));
    for (const r of rows) { const p = ov[unitOf(r.path, home).key]; if (p && p !== r.project) { r.project = p; r.confidence = 1; overridden++; } }
  }
  writeFileSync(jsonl, rows.map(r => JSON.stringify(r)).join('\n'));
  writeFileSync(join(opts.outDir, 'map.csv'), 'path,bytes,modified,project,confidence\n' + rows.map(r => `"${r.path.replace(/"/g, '""')}",${r.size},${new Date(r.modified).toISOString().slice(0, 10)},${r.project},${r.confidence.toFixed(2)}`).join('\n'));
  writeFileSync(join(opts.outDir, 'review.html'), reviewHtml(rows, home, ov));
  for (const r of rows) { const s = (summary[r.project] ??= { files: 0, gb: 0 }); s.files++; s.gb += r.size / 2 ** 30; }
  summary = Object.fromEntries(Object.entries(summary).sort((a, b) => b[1].gb - a[1].gb).map(([k, v]) => [k, { files: v.files, gb: +v.gb.toFixed(2) }]));
  writeFileSync(htmlPath, treemapHtml(rows, home));
  if (opts.open) spawn('cmd.exe', ['/c', 'start', '', htmlPath], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  return JSON.stringify({ status: 'done', action: opts.action, files: rows.length, units: unitCount || undefined, map_csv: join(opts.outDir, 'map.csv'), treemap: htmlPath, summary, elapsed_ms: Date.now() - started, decisions: unitCount ? Math.ceil((opts.limitUnits ?? unitCount) / 10) : 0, steps: 0, review: join(opts.outDir, 'review.html'), overridden });
}

// ---- root_plan: loose files directly in Downloads/Documents -> which EXISTING project folder they belong in (dry run, moves nothing) ----
const APP_FOLDERS = /^(New folder|Visual Studio \d+|My Web Sites|IISExpress|Contrib|Plugins|Examples|Docs|Actual|GitHub|PowerShell|Agent_Audits|Media-Stack|C# Scripts)$/i;
export async function rootPlan(opts: { roots: string[]; outDir: string; limit?: number; open: boolean }, addUsage: (u: unknown) => void) {
  const started = Date.now(), home = homedir();
  mkdirSync(opts.outDir, { recursive: true });
  const files = (await Promise.all(opts.roots.map(listFiles))).flat();
  const loose = files.filter(f => f.path.slice(home.length + 1).split('\\').length === 2);
  // destination candidates = folders that already exist: Documents\X, Documents\Office\X, Documents\Personal\X (contents are never touched)
  const cand = new Map<string, { n: number; names: string[] }>();
  for (const f of files) {
    const p = f.path.slice(home.length + 1).split('\\');
    if (p[0] !== 'Documents' || p.length < 3) continue;
    const depth = p[1] === 'Office' || p[1] === 'Personal' ? 3 : 2;
    if (p.length <= depth || APP_FOLDERS.test(p[depth - 1])) continue;
    const key = p.slice(0, depth).join('\\');
    const c = cand.get(key) ?? cand.set(key, { n: 0, names: [] }).get(key)!;
    c.n++; if (c.names.length < 3 && !c.names.includes(p[depth])) c.names.push(p[depth]);
  }
  const choices: Record<string, string> = {};
  for (const [k, c] of cand) choices[k] = `${c.n} files, e.g. ${c.names.join(', ')}`;
  choices['NEW'] = 'No existing folder fits; needs a new project folder';
  choices['LEAVE'] = 'Not project material (installer, temp, generic); leave in place or discard later';
  const todo = opts.limit ? loose.slice(0, opts.limit) : loose;
  const client = jevClient({ timeout: 60_000, retry: { maxRetries: 2 }, logLevel: 'off' });
  const out: { path: string; size: number; dest: string; confidence: number }[] = [];
  const BATCH = 5, PAR = 4; let next = 0;
  const batches: typeof todo[] = []; for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const questions: Record<string, ReturnType<typeof choice>> = {};
      b.forEach((f, i) => { questions['q' + i] = choice(`Which existing project folder should file "${f.path.split('\\').pop()}" (item q${i}) be filed in? Judge by its name, type and content excerpt only.`, choices); });
      try {
        const r = await client.systemOne({ state: { files: JSON.stringify(b.map((f, i) => ({ id: 'q' + i, name: f.path.split('\\').pop(), mb: +(f.size / 2 ** 20).toFixed(1), content: sample(f.path, f.size) }))) }, questions });
        addUsage(r.usage);
        b.forEach((f, i) => { const a = r.answers['q' + i]; out.push({ path: f.path, size: f.size, dest: a.type === 'choice' ? a.choice : 'LEAVE', confidence: a.type === 'choice' ? a.confidence : 0 }); });
      } catch { b.forEach(f => out.push({ path: f.path, size: f.size, dest: 'LEAVE', confidence: 0 })); }
    }
  }));
  writeFileSync(join(opts.outDir, 'root_plan.csv'), 'source,bytes,proposed_folder,confidence\n' + out.map(r => `"${r.path.replace(/"/g, '""')}",${r.size},${r.dest},${r.confidence.toFixed(2)}`).join('\n'));
  const units = out.map(r => ({ unit: r.path.slice(home.length + 1), project: r.dest, conf: r.confidence, n: 1, bytes: r.size, names: [] as string[] })).sort((a, b) => b.bytes - a.bytes);
  const page = readFileSync(join(import.meta.dirname, 'file-map-review.html'), 'utf8').replace('<title>File Map Review</title>', '<title>Root Files Plan</title>')
    .replace('__UNITS__', () => JSON.stringify(units)).replace('__PROJECTS__', () => JSON.stringify(Object.keys(choices))).replace('__DONE__', () => '{}').replace("'fm-dec'", "'fm-root'").replace("'fm-dec'", "'fm-root'").replace("'overrides.json'", "'root_plan_choices.json'").replace("'overrides.json'", "'root_plan_choices.json'");
  const htmlPath = join(opts.outDir, 'root_plan.html');
  writeFileSync(htmlPath, page);
  if (opts.open) spawn('cmd.exe', ['/c', 'start', '', htmlPath], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  const tally: Record<string, { files: number; gb: number }> = {};
  for (const r of out) { const t = (tally[r.dest] ??= { files: 0, gb: 0 }); t.files++; t.gb += r.size / 2 ** 30; }
  const top = Object.entries(tally).sort((a, b) => b[1].files - a[1].files).slice(0, 25).map(([k, v]) => [k, v.files, +v.gb.toFixed(2)]);
  return JSON.stringify({ status: 'done', action: 'root_plan', loose_files: loose.length, planned: out.length, candidate_folders: cand.size, plan_csv: join(opts.outDir, 'root_plan.csv'), page: htmlPath, top_destinations: top, elapsed_ms: Date.now() - started, decisions: batches.length, steps: 0 });
}

// Units (folders / loose files) with their project and confidence, for the pick-and-correct page.
function reviewHtml(rows: { path: string; size: number; project: string; confidence: number }[], home: string, ov: Record<string, string>): string {
  const m = new Map<string, { unit: string; project: string; conf: number; n: number; bytes: number; names: string[] }>();
  for (const r of rows) {
    const { key } = unitOf(r.path, home);
    let u = m.get(key); if (!u) { u = { unit: key, project: r.project, conf: r.confidence, n: 0, bytes: 0, names: [] }; m.set(key, u); }
    u.n++; u.bytes += r.size; if (u.names.length < 6) u.names.push(r.path.split('\\').pop()!);
  }
  const units = [...m.values()].sort((a, b) => b.bytes - a.bytes);
  const projects = Object.keys(DEFAULT_PROJECTS);
  return readFileSync(join(import.meta.dirname, 'file-map-review.html'), 'utf8').replace('__UNITS__', () => JSON.stringify(units)).replace('__PROJECTS__', () => JSON.stringify(projects)).replace('__DONE__', () => JSON.stringify(ov));
}
