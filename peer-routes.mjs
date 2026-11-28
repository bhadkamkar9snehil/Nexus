// One peer, several ways to reach it: LAN, Tailscale or the internet relay (#139).
import { isRelayAddress } from './relay-client.mjs';

const DIRECT = /^http:\/\/(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;

export function routeOf(url) {
  if (String(url).includes('/box/')) return 'relay';
  const ip = DIRECT.exec(url)?.[1]?.split('.').map(Number);
  return ip && ip[0] === 100 && ip[1] >= 64 && ip[1] < 128 ? 'tailscale' : 'lan';
}

/** Addresses a peer may advertise: plain IPv4 receivers (never loopback or link-local) and relay addresses. */
export function cleanAddresses(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(u => typeof u === 'string' && u.length <= 300 &&
    (isRelayAddress(u) || (DIRECT.test(u) && !/^http:\/\/(127\.|0\.|169\.254\.)/.test(u)))))].slice(0, 12);
}

/**
 * Order of attempts. A teammate with a relay address is reached only through it, because a stored private address may
 * belong to a stranger's computer on another network. Otherwise: the one that last worked, other direct ones, the relay.
 */
export function candidates(peer) {
  const relays = [peer.url, ...(peer.urls ?? [])].filter(isRelayAddress);
  if (!peer.own && relays.length) return [...new Set(relays)];
  const rest = (peer.urls ?? []).filter(u => u !== peer.url);
  return [peer.url, ...rest.filter(u => !isRelayAddress(u)), ...rest.filter(isRelayAddress)];
}

export const timeoutFor = (url, alternatives) => isRelayAddress(url) ? 12_000 : alternatives ? 2500 : 10_000;
