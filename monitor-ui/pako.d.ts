declare module 'pako' {
  export function inflateRaw(data: Uint8Array, options?: { to?: 'string' }): string;
}
