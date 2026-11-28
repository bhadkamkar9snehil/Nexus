import { probeNetwork } from '../network.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerNetworkTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('network_probe', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    if (args.ports !== undefined && !Array.isArray(args.ports)) throw new Error('Invalid ports');
    for (const key of ['quic_ports', 'dns_servers']) if (args[key] !== undefined && !Array.isArray(args[key])) throw new Error('Invalid ' + key);
          for (const key of ['system', 'ping', 'trace']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error('Invalid ' + key);
          output = JSON.stringify(await probeNetwork({ host: args.host === undefined ? undefined : required('host'), ports: args.ports as number[] | undefined, timeout_ms: args.timeout_ms as number | undefined, url: args.url === undefined ? undefined : required('url'), subnet: args.subnet === undefined ? undefined : required('subnet'), system: args.system as boolean | undefined, ping: args.ping as boolean | undefined, trace: args.trace as boolean | undefined, tls_port: args.tls_port as number | undefined, quic_ports: args.quic_ports as number[] | undefined, dns_servers: args.dns_servers as string[] | undefined }));
    return output;
  });
}
