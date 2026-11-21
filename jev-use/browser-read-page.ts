import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = join(import.meta.dirname, '..');
const cli = join(import.meta.dirname, 'node_modules', '@playwright', 'cli', 'playwright-cli.js');
const validSession = /^[a-zA-Z0-9_-]{1,40}$/;
const formats = ['markdown', 'text', 'html', 'links', 'metadata'] as const;

export type BrowserReadInput = {
  browser?: 'chrome' | 'edge';
  session: string;
  format?: typeof formats[number];
  max_chars?: number;
  offset_chars?: number;
  expected_sha256?: string;
};

// This expression is fixed by Nexus. Untrusted page content never becomes JavaScript source.
// It operates on a detached DOM clone, not the live page.
const EXTRACT_PAGE = String.raw`() => {
  const pageUrl = new URL(location.href);
  pageUrl.hash = '';
  pageUrl.username = '';
  pageUrl.password = '';
  for (const key of [...pageUrl.searchParams.keys()]) {
    if (/token|secret|password|key|auth|code|session|signature|credential/i.test(key)) {
      pageUrl.searchParams.set(key, '[redacted]');
    }
  }
  const safeUrl = (value) => {
    try {
      const u = new URL(value, location.href);
      if (!['http:', 'https:'].includes(u.protocol)) return '';
      u.username = '';
      u.password = '';
      for (const key of [...u.searchParams.keys()]) {
        if (/token|secret|password|key|auth|code|session|signature|credential/i.test(key)) {
          u.searchParams.set(key, '[redacted]');
        }
      }
      return u.href;
    } catch { return ''; }
  };
  const original = document.querySelector('main, article, [role="main"]') || document.body;
  if (!original) return { title: document.title, url: pageUrl.href, content: '', links: [], description: '' };
  const clone = original.cloneNode(true);
  clone.querySelectorAll('script,style,template,noscript,nav,aside,footer,form,input,select,textarea,button,svg,iframe,canvas,[hidden],[aria-hidden="true"]').forEach(el => el.remove());
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
  const canonical = safeUrl(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '');
  const links = [...clone.querySelectorAll('a[href]')].map(a => ({
    text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
    url: safeUrl(a.getAttribute('href') || '')
  })).filter(a => a.url).slice(0, 500);
  const inline = (n) => [...n.childNodes].map(render).join('').replace(/[ \t]+/g, ' ');
  function render(node) {
    if (node.nodeType === 3) return (node.textContent || '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + inline(node).trim() + '\n\n';
    if (tag === 'pre') return '\n\n' + String.fromCharCode(96).repeat(3) + '\n' + (node.textContent || '').trim() + '\n' + String.fromCharCode(96).repeat(3) + '\n\n';
    if (tag === 'code') return String.fromCharCode(96) + (node.textContent || '').trim() + String.fromCharCode(96);
    if (tag === 'br') return '\n';
    if (tag === 'p' || tag === 'blockquote') return '\n\n' + inline(node).trim() + '\n\n';
    if (tag === 'strong' || tag === 'b') return '**' + inline(node).trim() + '**';
    if (tag === 'em' || tag === 'i') return '*' + inline(node).trim() + '*';
    if (tag === 'a') {
      const href = safeUrl(node.getAttribute('href') || '');
      const label = inline(node).trim();
      return href && label ? '[' + label + '](' + href + ')' : label;
    }
    if (tag === 'img') {
      const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '').trim();
      const src = safeUrl(node.getAttribute('src') || '');
      return alt && src ? '![' + alt + '](' + src + ')' : alt;
    }
    if (tag === 'ul' || tag === 'ol') {
      return '\n' + [...node.children].map((li, i) => {
        if (li.tagName.toLowerCase() !== 'li') return render(li);
        return (tag === 'ol' ? String(i + 1) + '. ' : '- ') + inline(li).trim();
      }).join('\n') + '\n';
    }
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')].map(tr =>
        [...tr.children].filter(cell => /^(th|td)$/i.test(cell.tagName)).map(cell => inline(cell).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')));
      if (!rows.length || !rows[0].length) return '';
      const header = rows[0];
      return '\n\n| ' + header.join(' | ') + ' |\n| ' + header.map(() => '---').join(' | ') + ' |\n' +
        rows.slice(1).map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
    }
    if (tag === 'li') return '\n- ' + inline(node).trim();
    if (tag === 'div' || tag === 'section' || tag === 'main' || tag === 'article') return '\n' + inline(node) + '\n';
    return inline(node);
  }
  const markdown = render(clone).replace(/\n{3,}/g, '\n\n').trim();
  const text = (clone.innerText || clone.textContent || '').trim().replace(/\n{3,}/g, '\n\n');
  for (const el of [...clone.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (!['href', 'src', 'alt', 'title'].includes(attr.name)) el.removeAttribute(attr.name);
      else if (['href', 'src'].includes(attr.name)) {
        const href = safeUrl(attr.value);
        if (href) el.setAttribute(attr.name, href);
        else el.removeAttribute(attr.name);
      }
    }
  }
  return {
    title: document.title,
    language: document.documentElement?.lang || '',
    url: pageUrl.href,
    canonical,
    description,
    markdown,
    text,
    html: clone.outerHTML,
    links
  };
}`;

export function paginateBrowserContent(content: string, offsetChars: number, maxChars: number, expectedSha256?: string) {
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (expectedSha256 && expectedSha256 !== sha256) {
    return { status: 'blocked' as const, reason: 'content_changed', expected_sha256: expectedSha256, sha256 };
  }
  if (offsetChars > content.length) {
    return { status: 'blocked' as const, reason: 'offset_out_of_range', total_chars: content.length, sha256 };
  }
  const nextOffset = offsetChars + maxChars < content.length ? offsetChars + maxChars : null;
  return {
    status: 'done' as const, content: content.slice(offsetChars, offsetChars + maxChars),
    offset_chars: offsetChars, next_offset_chars: nextOffset,
    truncated: nextOffset !== null, total_chars: content.length,
    content_id: sha256, sha256,
  };
}

export async function browserReadPage(input: BrowserReadInput): Promise<string> {
  const choice = input.browser ?? 'chrome';
  const format = input.format ?? 'markdown';
  const maxChars = input.max_chars ?? 24_000;
  const offsetChars = input.offset_chars ?? 0;
  const expectedSha256 = input.expected_sha256;
  if (choice !== 'chrome' && choice !== 'edge') throw new Error('Invalid browser');
  if (!validSession.test(input.session)) throw new Error('Invalid session');
  if (!formats.includes(format)) throw new Error('Invalid output format');
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 48_000) throw new Error('Invalid max_chars');
  if (!Number.isSafeInteger(offsetChars) || offsetChars < 0) throw new Error('Invalid offset_chars');
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('Invalid expected_sha256');
  const session = 'jev-' + choice + '-' + input.session;
  const lock = join(root, '.sessions', session + '.lock');
  await mkdir(join(root, '.sessions'), { recursive: true });
  try { await mkdir(lock); }
  catch (e: any) {
    if (e.code === 'EEXIST') return JSON.stringify({ status: 'blocked', reason: 'session_busy', session });
    throw e;
  }
  const call = async (command: string, argument?: string) => {
    const { stdout } = await execute(process.execPath, [cli, '-s=' + session, command, ...(argument ? [argument] : []), '--json'], {
      cwd: import.meta.dirname, timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    const data = JSON.parse(stdout);
    if (data.isError) throw new Error('Browser read failed');
    return data;
  };
  try {
    const browsers = (await call('list')).browsers ?? [];
    if (!browsers.some((b: any) => b.name === session && b.status === 'open')) {
      return JSON.stringify({ status: 'blocked', reason: 'session_not_open', session });
    }
    const result = await call('eval', EXTRACT_PAGE);
    if (typeof result.result !== 'string') throw new Error('Invalid browser extract response');
    const page = JSON.parse(result.result);
    const content = format === 'metadata' ? '' : format === 'links' ? JSON.stringify(page.links) : String(page[format] ?? '');
    const slice = paginateBrowserContent(content, offsetChars, maxChars, expectedSha256);
    if (slice.status === 'blocked') return JSON.stringify({ ...slice, session });
    return JSON.stringify({
      backend: 'playwright', session, format,
      retrieved_at: new Date().toISOString(),
      title: String(page.title ?? '').slice(0, 400),
      language: String(page.language ?? '').slice(0, 40),
      url: String(page.url ?? '').slice(0, 2000),
      canonical: String(page.canonical ?? '').slice(0, 2000),
      description: String(page.description ?? '').slice(0, 1000),
      ...slice,
      warnings: content.length || format === 'metadata' ? [] : ['empty_content'],
      links_count: Array.isArray(page.links) ? page.links.length : 0,
    });
  } finally {
    await rmdir(lock);
  }
}
