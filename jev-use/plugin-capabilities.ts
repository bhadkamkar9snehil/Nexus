import { z } from 'zod';

export const NexusCapability = z.enum([
  'web.scrape', 'web.map', 'web.crawl', 'web.batch',
  'web.extract', 'web.monitor', 'mcp.tools',
]);

export const NexusPermission = z.enum([
  'network.public', 'network.private', 'browser.session.read',
  'files.read', 'files.write', 'process.launch',
]);

const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const PluginManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(3).max(100).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  minNexusVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  protocol: z.enum(['nexus-http', 'mcp-stdio', 'mcp-http', 'firecrawl-v2']),
  capabilities: z.array(NexusCapability).min(1).max(32).refine(unique, 'Duplicate capability'),
  permissions: z.array(NexusPermission).max(16).refine(unique, 'Duplicate permission'),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type Capability = z.infer<typeof NexusCapability>;
export type Permission = z.infer<typeof NexusPermission>;

export type PluginProvider = {
  // Implementations must be trusted Nexus adapters to external processes/services.
  // This interface never evaluates or imports arbitrary plugin code.
  execute(capability: Capability, input: unknown, signal: AbortSignal): Promise<unknown>;
};

type Entry = {
  manifest: PluginManifest;
  provider: PluginProvider;
  enabled: boolean;
  grants: Set<Permission>;
  lastError?: string;
};

export class PluginCapabilityRegistry {
  private readonly plugins = new Map<string, Entry>();

  constructor(private readonly nexusVersion = '0.0.0') {}

  register(raw: unknown, provider: PluginProvider): PluginManifest {
    const manifest = PluginManifestSchema.parse(raw);
    if (manifest.minNexusVersion) {
      const current = this.nexusVersion.split('.').map(Number);
      const minimum = manifest.minNexusVersion.split('.').map(Number);
      const compatible = current[0] > minimum[0] ||
        (current[0] === minimum[0] && current[1] > minimum[1]) ||
        (current[0] === minimum[0] && current[1] === minimum[1] && current[2] >= minimum[2]);
      if (!compatible) throw new Error('Plugin requires a newer Nexus version');
    }
    if (this.plugins.has(manifest.id)) throw new Error('Duplicate plugin ID: ' + manifest.id);
    if (!provider || typeof provider.execute !== 'function') throw new Error('Invalid plugin provider');
    this.plugins.set(manifest.id, { manifest, provider, enabled: false, grants: new Set() });
    return manifest;
  }

  enable(id: string, approvedPermissions: readonly Permission[]): void {
    const entry = this.mustGet(id);
    const grants = new Set(approvedPermissions.map(permission => NexusPermission.parse(permission)));
    const unrequested = [...grants].filter(permission => !entry.manifest.permissions.includes(permission));
    if (unrequested.length) throw new Error('Plugin requested no such permissions: ' + unrequested.join(', '));
    const missing = entry.manifest.permissions.filter(permission => !grants.has(permission));
    if (missing.length) throw new Error('Plugin permissions not approved: ' + missing.join(', '));
    entry.grants = grants;
    entry.enabled = true;
    entry.lastError = undefined;
  }

  disable(id: string): void {
    const entry = this.mustGet(id);
    entry.enabled = false;
    entry.grants.clear();
  }

  list(): Array<{
    id: string;
    name: string;
    version: string;
    enabled: boolean;
    capabilities: Capability[];
    permissions: Permission[];
    lastError?: string;
  }> {
    return [...this.plugins.values()].map(entry => ({
      id: entry.manifest.id,
      name: entry.manifest.name,
      version: entry.manifest.version,
      enabled: entry.enabled,
      capabilities: [...entry.manifest.capabilities],
      permissions: [...entry.manifest.permissions],
      lastError: entry.lastError,
    }));
  }

  select(capability: Capability, providerId?: string): string | null {
    NexusCapability.parse(capability);
    if (!providerId || providerId === 'nexus.core') return null;
    const entry = this.mustGet(providerId);
    if (!entry.enabled) throw new Error('Plugin is disabled: ' + providerId);
    if (!entry.manifest.capabilities.includes(capability)) {
      throw new Error('Plugin does not provide capability: ' + capability);
    }
    return providerId;
  }

  async execute(providerId: string, capability: Capability, input: unknown, timeoutMs = 30_000): Promise<unknown> {
    this.select(capability, providerId);
    const entry = this.mustGet(providerId);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new Error('Invalid plugin timeout');
    }
    const controller = new AbortController();
    // A normal timer keeps Node 22 alive while the provider is pending.
    // AbortSignal.timeout alone uses an unref'd timer and can cancel a test before rejection.
    const timer = setTimeout(() => controller.abort(new Error('Plugin timed out')), timeoutMs);
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('Plugin timed out')), { once: true });
      });
      const result = await Promise.race([entry.provider.execute(capability, input, controller.signal), timeout]);
      entry.lastError = undefined;
      return result;
    } catch (error) {
      // Monitor status must never contain provider output, URLs, tokens or secret values.
      entry.lastError = error instanceof Error ? error.name : 'PluginError';
      throw new Error('Plugin execution failed: ' + providerId, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private mustGet(id: string): Entry {
    const entry = this.plugins.get(id);
    if (!entry) throw new Error('Unknown plugin: ' + id);
    return entry;
  }
}
