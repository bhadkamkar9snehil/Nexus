// Loopback-only server for the file-map pages: serves out_dir and saves decisions with one click (no save dialog).
// Usage: node file-map-serve.mjs <out_dir> [port]
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8766);
const origin = `http://127.0.0.1:${port}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json' };
const SAVE = new Set(['overrides.json', 'root_plan_choices.json']); // the only files the pages may write

http.createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
  if (req.method === 'POST' && name.startsWith('save/')) {
    const file = name.slice(5);
    // a random website must not be able to write here: require our own origin
    if (!SAVE.has(file) || req.headers.origin !== origin) { res.statusCode = 403; return res.end('forbidden'); }
    let body = ''; req.on('data', c => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', () => {
      try {
        const path = join(dir, file);
        const merged = { ...(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}), ...JSON.parse(body) }; // earlier saves are kept
        writeFileSync(path, JSON.stringify(merged, null, 1));
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(merged));
      } catch { res.statusCode = 400; res.end('bad json'); }
    });
    return;
  }
  const ok = /^[\w.-]+\.(html|csv|json)$/.test(name) && existsSync(join(dir, name)); // flat names only: no path traversal
  if (req.method !== 'GET' || !ok) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[extname(name)]); res.end(readFileSync(join(dir, name)));
}).listen(port, '127.0.0.1', () => console.log('file-map server', origin));
