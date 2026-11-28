import { networkInterfaces } from 'node:os';
import { lookup, reverse, Resolver } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { createConnection, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect as tlsConnect } from 'node:tls';

const exec = promisify(execFile);
export function subnetHosts(cidr: string) {
  const [ip, prefixText, extra] = cidr.split('/');
  const prefix = Number(prefixText);
  if (extra !== undefined || isIP(ip) !== 4 || !/^\d+$/.test(prefixText ?? '') || prefix < 24 || prefix > 30) throw new Error('Subnet must be IPv4 /24 through /30');
  const value = ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const base = (value & mask) >>> 0;
  const count = 2 ** (32 - prefix);
  return Array.from({ length: count - 2 }, (_, i) => { const n = (base + i + 1) >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); });
}
async function command(file: string, args: string[], timeout: number) {
  try { const r = await exec(file, args, { timeout, windowsHide: true, maxBuffer: 256 * 1024 }); return { status: 'done', output: r.stdout.trim() }; }
  catch (e) { const err = e as NodeJS.ErrnoException & { stdout?: string; killed?: boolean }; return { status: err.killed ? 'timeout' : String(err.code ?? 'error'), output: String(err.stdout ?? '').trim() }; }
}

/** A QUIC long header with a reserved version: any QUIC server must answer with Version Negotiation (version 0), no handshake needed. */
export function quicProbePacket() {
  const packet = Buffer.alloc(1200);
  packet[0] = 0xc0;
  packet.writeUInt32BE(0x0a0a0a0a, 1);
  packet[5] = 8; randomBytes(8).copy(packet, 6);
  packet[14] = 8; randomBytes(8).copy(packet, 15);
  return packet;
}
export function quicProbe(address: string, port: number, timeout: number) {
  return new Promise<{ port: number; status: string; elapsed_ms: number }>(resolve => {
    const started = Date.now(), packet = quicProbePacket();
    const socket = createSocket(isIP(address) === 6 ? 'udp6' : 'udp4');
    let finished = false;
    const finish = (status: string) => { if (finished) return; finished = true; clearTimeout(timer); socket.close(); resolve({ port, status, elapsed_ms: Date.now() - started }); };
    const timer = setTimeout(() => finish('no_reply'), timeout);
    // The reply echoes our source connection ID as its destination ID.
    socket.on('message', reply => { if (reply.length > 14 && reply[0] & 0x80 && reply.readUInt32BE(1) === 0 && reply.subarray(6, 6 + reply[5]).equals(packet.subarray(15, 23))) finish('quic_reply'); });
    socket.on('error', e => finish((e as NodeJS.ErrnoException).code ?? 'error'));
    socket.connect(port, address, () => { socket.send(packet); setTimeout(() => { if (!finished) socket.send(packet); }, Math.floor(timeout / 2)).unref(); });
  });
}

export async function probeNetwork(options: { host?: string; ports?: number[]; timeout_ms?: number; url?: string; system?: boolean; ping?: boolean; trace?: boolean; tls_port?: number; subnet?: string; quic_ports?: number[]; dns_servers?: string[] }) {
  const timeout = options.timeout_ms ?? 2000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 10000) throw new Error('Invalid timeout_ms');
  const discoveryHosts = options.subnet ? subnetHosts(options.subnet) : null;
  if (discoveryHosts && timeout > 5000) throw new Error('Subnet discovery timeout_ms cannot exceed 5000');
  const ports = options.ports ?? [];
  if (ports.length > 100 || ports.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('Invalid ports');
  const host = options.host;
  if (host && (host.length > 253 || !/^[a-zA-Z0-9.:-]+$/.test(host))) throw new Error('Invalid host');
  const quicPorts = options.quic_ports ?? [];
  if (quicPorts.length > 10 || quicPorts.some(p => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('Invalid quic_ports');
  const dnsServers = options.dns_servers ?? [];
  if (dnsServers.length > 6 || dnsServers.some(s => !isIP(s))) throw new Error('dns_servers must be up to 6 IP addresses');
  if (!host && (ports.length || quicPorts.length || dnsServers.length)) throw new Error('host required for port and DNS server checks');
  if (!host && (options.ping || options.trace || options.tls_port)) throw new Error('host required for ping, trace and TLS');
  if (options.tls_port !== undefined && (!Number.isInteger(options.tls_port) || options.tls_port < 1 || options.tls_port > 65535)) throw new Error('Invalid tls_port');
  let url: URL | undefined;
  if (options.url) {
    url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials');
  }
  const dns = host ? await Promise.race([
    (isIP(host) ? reverse(host).then(names => ({ names })) : lookup(host, { all: true }).then(addresses => ({ addresses }))).catch(e => ({ error: e.code ?? 'DNS_ERROR' })),
    new Promise<{ error: string }>(resolve => setTimeout(() => resolve({ error: 'TIMEOUT' }), timeout)),
  ]) : null;
  const tcp = await Promise.all(ports.map(port => new Promise<{ port: number; status: string; elapsed_ms: number }>(resolve => {
    const started = Date.now();
    const socket = createConnection({ host: host!, port });
    let finished = false;
    const finish = (status: string) => { if (finished) return; finished = true; socket.destroy(); resolve({ port, status, elapsed_ms: Date.now() - started }); };
    socket.setTimeout(timeout, () => finish('timeout'));
    socket.once('connect', () => finish('open'));
    socket.once('error', e => finish((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : (e as NodeJS.ErrnoException).code ?? 'error'));
  })));
  const http = url ? await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeout) }).then(r => ({ status_code: r.status, location: r.headers.get('location') })).catch(e => ({ error: e.cause?.code ?? e.name ?? 'error' })) : null;
  const tls = options.tls_port ? await new Promise<object>(resolve => {
    const socket = tlsConnect({ host: host!, port: options.tls_port!, servername: isIP(host!) ? undefined : host, rejectUnauthorized: false });
    let finished = false;
    const finish = (value: object) => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
    socket.setTimeout(timeout, () => finish({ error: 'TIMEOUT' }));
    socket.once('secureConnect', () => { const c = socket.getPeerCertificate(); finish({ authorized: socket.authorized, authorization_error: socket.authorizationError, protocol: socket.getProtocol(), subject: c.subject, issuer: c.issuer, valid_from: c.valid_from, valid_to: c.valid_to }); });
    socket.once('error', e => finish({ error: (e as NodeJS.ErrnoException).code ?? 'error' }));
  }) : null;
  const quic = await Promise.all(quicPorts.map(port => quicProbe(host!, port, timeout)));
  // Ask each server directly (A records), to tell a broken system resolver apart from a blocked network.
  const resolvers = await Promise.all(dnsServers.map(async server => {
    const resolver = new Resolver({ timeout, tries: 1 });
    resolver.setServers([server]);
    return resolver.resolve4(host!).then(addresses => ({ server, addresses })).catch(e => ({ server, error: String(e.code ?? 'DNS_ERROR') }));
  }));
  const system = options.system ? Object.fromEntries(await Promise.all([
    ['ipconfig', 'ipconfig.exe', ['/all']], ['firewall', 'netsh.exe', ['advfirewall', 'show', 'allprofiles']], ['routes', 'route.exe', ['print']], ['neighbors', 'arp.exe', ['-a']],
  ].map(async ([name, file, args]) => [name, await command(file as string, args as string[], timeout)]))) : null;
  const ping = options.ping ? await command('ping.exe', ['-n', '1', '-w', String(timeout), host!], timeout + 1000) : null;
  const trace = options.trace ? await command('tracert.exe', ['-d', '-h', '16', '-w', String(timeout), host!], Math.min(timeout * 16 + 1000, 30000)) : null;
  const discovery: { host: string; status: string }[] = [];
  if (discoveryHosts) {
    const hosts = discoveryHosts;
    for (let i = 0; i < hosts.length; i += 16) {
      discovery.push(...await Promise.all(hosts.slice(i, i + 16).map(async target => {
        const r = await command('ping.exe', ['-n', '1', '-w', String(timeout), target], timeout + 1000);
        return { host: target, status: r.status === 'done' && /TTL[=]/i.test(r.output) ? 'responded' : r.status === 'done' ? 'no_reply' : r.status };
      })));
    }
  }
  return { status: 'done', observed_at: new Date().toISOString(), interfaces: networkInterfaces(), system, host: host ?? null, dns, resolvers, tcp, quic, ping, trace, http, tls, discovery: options.subnet ? { subnet: options.subnet, method: 'icmp', hosts: discovery } : null, decisions: 0, steps: 0 };
}
