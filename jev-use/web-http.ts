import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { browserReadPage } from './browser-read-page.js';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

export type WebScrapeInput = {
  url: string;
  format?: 'markdown' | 'text' | 'html' | 'links' | 'metadata';
  max_chars?: number;
  browser_session?: string;
  browser?: 'chrome' | 'edge';
};

export function isPublicIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  if (ip === '::' || ip === '::1' || ip.startsWith('::ffff:')) return false;
  const prefix = parseInt(ip.split(':')[0] || '0', 16);
  if ((prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80 ||
      (prefix & 0xff00) === 0xff00 || ip.startsWith('2001:db8:') ||
      ip.startsWith('2001:0:') || ip.startsWith('2002:') ||
      ip.startsWith('64:ff9b:')) return false;
  return true;
}

export function validatePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('HTTP(S) URL required');
  if (url.username || url.password) throw new Error('Embedded URL credentials are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Private network destination blocked');
  }
  if (isIP(hostname) && !isPublicIp(hostname)) throw new Error('Private network destination blocked');
  return url;
}

async function publicLookup(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicIp(entry.address))) {
    throw new Error('Private or unsafe DNS result blocked');
  }
  return addresses[0];
}

function readHttp(url: URL): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET',
      agent: false,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'Nexus-Web-Reader/1.0',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'Accept-Encoding': 'identity',
      },
      lookup: ((host: string, options: { all?: boolean }, callback: (error: Error | null, value?: unknown, family?: number) => void) => {
        publicLookup(host).then(ip => {
          if (options?.all) callback(null, [{ address: ip.address, family: ip.family }]);
          else callback(null, ip.address, ip.family);
        }, err => callback(err));
      }) as any,
    }, response => {
      const status = response.statusCode ?? 0;
      const headers = response.headers;
      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, body: '', headers });
        return;
      }
      const encoding = String(headers['content-encoding'] ?? 'identity').toLowerCase();
      if (encoding !== 'identity') {
        response.resume();
        reject(new Error('Unsupported compressed response'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('Response exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const type = String(headers['content-type'] ?? 'text/html').toLowerCase();
        if (!type.startsWith('text/html') && !type.startsWith('text/plain') &&
            !type.startsWith('application/xhtml+xml')) {
          reject(new Error('Unsupported content type'));
          return;
        }
        const charset = /charset=([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
        let decoded: string;
        try { decoded = new TextDecoder(charset).decode(Buffer.concat(chunks)); }
        catch { decoded = Buffer.concat(chunks).toString('utf8'); }
        resolve({ status, body: decoded, headers });
      });
      response.on('error', reject);
    });
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new Error('Web request timeout')));
    request.on('error', reject);
    request.end();
  });
}

function safeLink(value: string, base: string): string {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|key|auth|code|session|signature|credential/i.test(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.href;
  } catch { return ''; }
}

export function extractStaticHtml(html: string, baseUrl: string) {
  const document = parseHTML(html).document;
  const root = document.querySelector('main, article, [role="main"]') ?? document.body;
  const fragment = root?.cloneNode(true) as Element | undefined;
  if (!fragment) return { title: document.title ?? '', description: '', canonical: '', markdown: '', text: '', html: '', links: [] };
  fragment.querySelectorAll('script,style,template,noscript,nav,aside,footer,form,input,select,textarea,button,svg,iframe,canvas,[hidden],[aria-hidden="true"]').forEach(node => node.remove());
  const links = Array.from(fragment.querySelectorAll('a[href]')).map(node => ({
    text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    url: safeLink(node.getAttribute('href') || '', baseUrl),
  })).filter(link => link.url).slice(0, 500);
  for (const node of Array.from(fragment.querySelectorAll('*'))) {
    for (const attribute of Array.from(node.attributes)) {
      if (!['href', 'src', 'alt', 'title'].includes(attribute.name)) node.removeAttribute(attribute.name);
      else if (attribute.name === 'href' || attribute.name === 'src') {
        const url = safeLink(attribute.value, baseUrl);
        if (url) node.setAttribute(attribute.name, url);
        else node.removeAttribute(attribute.name);
      }
    }
  }
  const cleanHtml = fragment.outerHTML;
  const markdown = NodeHtmlMarkdown.translate(cleanHtml).trim();
  const text = (fragment.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: (document.querySelector('title')?.textContent ?? '').trim(),
    description: (document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '').trim(),
    canonical: safeLink(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '', baseUrl),
    markdown, text, html: cleanHtml, links,
  };
}

export async function webScrape(input: WebScrapeInput): Promise<string> {
  const started = Date.now();
  const format = input.format ?? 'markdown';
  const maxChars = input.max_chars ?? 24_000;
  if (!['markdown', 'text', 'html', 'links', 'metadata'].includes(format)) throw new Error('Invalid format');
  if (!Number.isSafeInteger(maxChars) || maxChars < 100 || maxChars > 48_000) throw new Error('Invalid max_chars');
  if (input.browser_session !== undefined && !/^[a-zA-Z0-9_-]{1,40}$/.test(input.browser_session)) throw new Error('Invalid browser_session');
  if (input.browser !== undefined && !['chrome','edge'].includes(input.browser)) throw new Error('Invalid browser');
  let url = validatePublicUrl(input.url);
  let response: Awaited<ReturnType<typeof readHttp>> | undefined;
  let redirects = 0;
  for (;;) {
    response = await readHttp(url);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (++redirects > MAX_REDIRECTS) throw new Error('Too many redirects');
    const location = response.headers.location;
    if (!location || Array.isArray(location)) throw new Error('Missing or invalid redirect');
    url = validatePublicUrl(new URL(location, url).href);
  }
  if (response.status < 200 || response.status >= 300) {
    return JSON.stringify({
      status: response.status === 403 || response.status === 429 ? 'blocked' : 'error',
      http_status: response.status, backend: 'http', url: safeLink(url.href, url.href),
      reason: 'http_status', elapsed_ms: Date.now() - started,
    });
  }
  const parsed = String(response.headers['content-type'] ?? '').startsWith('text/plain')
    ? { title: '', description: '', canonical: '', markdown: response.body, text: response.body, html: '', links: [] }
    : extractStaticHtml(response.body, url.href);
  const content = format === 'metadata' ? '' : format === 'links' ? JSON.stringify(parsed.links) : parsed[format];
  const requiresBrowser = parsed.markdown.length < 80 && /<script\b/i.test(response.body) &&
    /id=["'](?:root|app|__next)["']|__NEXT_DATA__|window\.__/i.test(response.body);
  if (requiresBrowser && input.browser_session) {
    const browserResult = JSON.parse(await browserReadPage({
      session: input.browser_session, browser: input.browser ?? 'chrome',
      format, max_chars: maxChars,
    }));
    if (browserResult.status === 'done') {
      const observed = new URL(browserResult.url);
      // An existing session must already show the requested page. Never navigate it implicitly.
      if (observed.origin === url.origin && observed.pathname === url.pathname) {
        return JSON.stringify({ ...browserResult, fallback_used: true,
          source_url: safeLink(url.href, url.href), http_status: response.status,
          elapsed_ms: Date.now() - started });
      }
    }
  }
  return JSON.stringify({
    status: 'done', backend: 'http', http_status: response.status,
    url: safeLink(url.href, url.href), title: parsed.title, canonical: parsed.canonical,
    description: parsed.description.slice(0, 1000),
    format, content: content.slice(0, maxChars),
    truncated: content.length > maxChars, total_chars: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    links_count: parsed.links.length, requires_browser: requiresBrowser,
    elapsed_ms: Date.now() - started,
  });
}
