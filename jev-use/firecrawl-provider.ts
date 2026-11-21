import type { Capability, PluginManifest, PluginProvider } from './plugin-capabilities.js';
import { validatePublicUrl } from './web-http.js';

export type FirecrawlMode = 'local' | 'self-hosted' | 'cloud';
export type FirecrawlConfig = {
  mode: FirecrawlMode;
  endpoint?: string;
  apiKey?: string;
  // Operator assertion; the managed process must actually set FIRECRAWL_CLOUD=off.
  cloudOffConfirmed?: boolean;
};

const CLOUD_ENDPOINT = 'https://api.firecrawl.dev';
const LOCAL_ENDPOINT = 'http://127.0.0.1:3002';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SUPPORTED = ['web.scrape','web.map','web.crawl','web.batch'] as const;

export function firecrawlManifest(mode: FirecrawlMode): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'dev.firecrawl',
    name: 'Firecrawl',
    version: '1.0.0',
    protocol: 'firecrawl-v2',
    capabilities: [...SUPPORTED],
    // Local loopback is a separate, owner-approved private-network capability.
    permissions: [mode === 'cloud' ? 'network.public' : 'network.private'],
  };
}

export class FirecrawlV2Provider implements PluginProvider {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly mode: FirecrawlMode;

  constructor(config: FirecrawlConfig) {
    if (!['local', 'self-hosted', 'cloud'].includes(config.mode)) throw new Error('Invalid Firecrawl mode');
    this.mode = config.mode;
    const parsed = new URL(config.endpoint || (config.mode === 'cloud' ? CLOUD_ENDPOINT : LOCAL_ENDPOINT));
    if (parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('Invalid Firecrawl endpoint');
    if (config.mode === 'local') {
      if (config.cloudOffConfirmed !== true) throw new Error('Local Firecrawl requires FIRECRAWL_CLOUD=off confirmation');
      if (parsed.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(parsed.hostname)) {
        throw new Error('Local Firecrawl requires a loopback HTTP endpoint');
      }
    } else if (config.mode === 'cloud') {
      if (parsed.origin !== CLOUD_ENDPOINT || parsed.pathname !== '/') {
        throw new Error('Cloud Firecrawl must use the official API endpoint');
      }
      if (!config.apiKey || config.apiKey.trim().length < 5) throw new Error('Cloud Firecrawl requires explicit credentials');
    } else if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Self-hosted Firecrawl requires HTTP(S)');
    }
    this.apiKey = config.mode === 'cloud' || config.mode === 'self-hosted' ? config.apiKey : undefined;
    this.endpoint = parsed.origin;
  }

  async execute(capability: Capability, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (!SUPPORTED.includes(capability as any)) throw new Error('Unsupported Firecrawl capability');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Firecrawl input');
    const args = input as Record<string, unknown>;
    const action = args.action === undefined ? 'start' : args.action;
    if (!['start', 'status', 'cancel'].includes(String(action))) throw new Error('Invalid Firecrawl action');
    if (action !== 'start' && !['web.crawl','web.batch'].includes(capability)) {
      throw new Error('Only crawl and batch jobs support status or cancel');
    }
    const route = {
      'web.scrape': '/v2/scrape',
      'web.map': '/v2/map',
      'web.crawl': '/v2/crawl',
      'web.batch': '/v2/batch/scrape',
    }[capability as typeof SUPPORTED[number]];
    let path = route;
    let method = 'POST';
    let payload: string | undefined;
    if (action !== 'start') {
      if (typeof args.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(args.id)) {
        throw new Error('Invalid job ID');
      }
      path += '/' + args.id;
      method = action === 'status' ? 'GET' : 'DELETE';
    } else {
      const request = { ...args };
      delete request.action;
      delete request.id;
      // Credentials and arbitrary headers must never travel in a page scrape payload.
      if (Object.keys(request).some(key => /^(headers|authorization|cookie|apiKey|token)$/i.test(key))) {
        throw new Error('Credentials and custom headers are not accepted in page inputs');
      }
      if (capability === 'web.batch') {
        if (!Array.isArray(request.urls) || request.urls.length < 1 || request.urls.length > 100 ||
            !request.urls.every(url => typeof url === 'string')) throw new Error('Invalid batch URLs');
        for (const url of request.urls as string[]) validatePublicUrl(url);
      } else {
        if (typeof request.url !== 'string') throw new Error('URL required');
        validatePublicUrl(request.url);
      }
      payload = JSON.stringify(request);
      if (Buffer.byteLength(payload) > 64 * 1024) throw new Error('Firecrawl request exceeds size limit');
    }
    const abort = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const response = await fetch(this.endpoint + path, {
      method, redirect: 'error', signal: abort,
      headers: {
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...(this.apiKey ? { 'Authorization': 'Bearer ' + this.apiKey } : {}),
      },
      body: payload,
    });
    if (!response.ok) {
      // Server response bodies can contain request data. Do not return them in exceptions.
      throw new Error('Firecrawl provider HTTP ' + response.status);
    }
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw new Error('Firecrawl returned a non-JSON response');
    const bytes: Uint8Array[] = [];
    let total = 0;
    if (!response.body) throw new Error('Firecrawl returned no response body');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_JSON_BYTES) {
          await reader.cancel();
          throw new Error('Firecrawl response exceeds size limit');
        }
        bytes.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(bytes).toString('utf8'));
    return { provider: 'firecrawl', mode: this.mode, capability, data: result };
  }
}
