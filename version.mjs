// Which Nexus this is, and whether a newer release exists. Installed bundles carry a VERSION file; a source checkout
// reports its latest git tag. The latest release is checked in parallel across GitHub and GitLab (LAN + Tailscale) and cached.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const GITHUB_FEED = 'https://api.github.com/repos/bhadkamkar9snehil/Nexus/releases/latest';
const GITLAB_HOSTS = ['http://10.2.6.112:8080', 'http://100.110.236.122:8080'];
const GITLAB_PATH = '/api/v4/projects/ssm%2Fshared-computer-use/releases?per_page=1';
const CACHE_MS = 30 * 60_000;
let cached;

const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1).map(Number) ?? null;
export function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const git = (root, args) => new Promise((resolve) => execFile('git', ['-C', root, ...args], { windowsHide: true, timeout: 5000 }, (e, out) => resolve(e ? null : out.trim())));

/** {version, source: 'installed' | 'source', ahead} for this installation. */
export async function currentVersion(root, { readText = (p) => readFile(p, 'utf8'), run = git } = {}) {
  try {
    const text = (await readText(join(root, 'VERSION'))).trim();
    if (text && text !== 'dev') return { version: text.replace(/^v/, ''), source: 'installed', ahead: 0 };
  } catch { /* not an installed bundle */ }
  const described = await run(root, ['describe', '--tags', '--long', '--match', 'v*']); // v1.12.0-3-gabc1234
  const m = /^v?(.+)-(\d+)-g[0-9a-f]+$/.exec(described ?? '');
  return m ? { version: m[1], source: 'source', ahead: Number(m[2]) } : { version: 'dev', source: 'source', ahead: 0 };
}

async function fetchGitHub(fetcher) {
  const reply = await fetcher(GITHUB_FEED, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nexus-monitor' } });
  if (!reply.ok) return null;
  const j = await reply.json();
  if (!j?.tag_name) return null;
  return { version: String(j.tag_name).replace(/^v/, ''), url: j.html_url ?? null, source: 'github' };
}

async function fetchGitLab(fetcher) {
  const race = new AbortController();
  try {
    return await Promise.any(GITLAB_HOSTS.map(async (host) => {
      const signal = AbortSignal.any ? AbortSignal.any([race.signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000);
      const reply = await fetcher(host + GITLAB_PATH, { signal, headers: { 'User-Agent': 'nexus-monitor' } });
      if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
      const rows = await reply.json();
      const first = Array.isArray(rows) ? rows[0] : null;
      if (!first?.tag_name) throw new Error('empty');
      race.abort();
      return {
        version: String(first.tag_name).replace(/^v/, ''),
        url: first._links?.self ?? `${host}/ssm/shared-computer-use/-/releases/${first.tag_name}`,
        source: 'gitlab',
      };
    }));
  } catch {
    return null;
  }
}

/** Full answer for the status bar. Never throws; offline or rate-limited means no `latest`. */
export async function versionInfo(root, { fetcher = fetch, now = Date.now, ...deps } = {}) {
  const current = await currentVersion(root, deps);
  if (!cached || now() - cached.at > CACHE_MS) {
    const [gh, gl] = await Promise.all([
      fetchGitHub(fetcher).catch(() => null),
      fetchGitLab(fetcher).catch(() => null),
    ]);
    let latest = gh ?? gl ?? null;
    if (gh && gl && isNewer(gl.version, gh.version)) latest = gl;
    cached = { at: now(), latest };
  }
  const latest = cached.latest;
  return { ...current, latest: latest?.version ?? null, url: latest?.url ?? null, newer: Boolean(latest && isNewer(latest.version, current.version)) };
}

export const resetVersionCache = () => { cached = undefined; };
