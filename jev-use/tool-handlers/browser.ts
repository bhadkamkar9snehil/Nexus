import { playwrightBrowser } from '../playwright-browser.js';
import { browserReadPage } from '../browser-read-page.js';
import { webScrape } from '../web-http.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerBrowserTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('web_scrape', async ({ args }) => webScrape({
    url: args.url as string,
    format: args.format,
    max_chars: args.max_chars,
    browser_session: args.browser_session,
    browser: args.browser,
  }));
  registry.bind('browser_read_page', async ({ args }) => browserReadPage({
    session: args.session as string,
    browser: args.browser,
    format: args.format,
    max_chars: args.max_chars,
    offset_chars: args.offset_chars,
    expected_sha256: args.expected_sha256,
  }));
  registry.bind('jev_browse', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const url = new URL(required('url'));
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials');
          const escaped = required('expect_text').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const choice = args.browser ?? 'chrome';
          if (choice !== 'chrome' && choice !== 'edge') throw new Error('Invalid browser; use chrome or edge');
          const backend = args.backend ?? 'cdp';
          if (backend !== 'cdp' && backend !== 'playwright') throw new Error('Invalid backend');
          const session = args.session === undefined ? 'shared' : required('session');
          if (!/^[a-zA-Z0-9_-]{1,40}$/.test(session)) throw new Error('Invalid session');
          const fields = args.fields ?? {};
          if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.entries(fields).some(([key, value]) => !key || typeof value !== 'string' || value.length > 2000) || Object.keys(fields).length > 20) throw new Error('Invalid fields');
          output = backend === 'playwright'
            ? await playwrightBrowser({ goal, url: url.href, expect: required('expect_text'), browser: choice, session, fields: fields as Record<string, string>, maxSteps: limit }, addUsage)
            : await browserTask({ goal, url: url.href, expect: { text_match: escaped }, max_steps: limit, stop_at_challenge: true }, choice, addUsage);
    return output;
  });
}
