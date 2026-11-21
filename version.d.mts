export function isNewer(latest: string, current: string): boolean;
export function currentVersion(root: string, deps?: { readText?: (path: string) => Promise<string>; run?: (root: string, args: string[]) => Promise<string | null> }): Promise<{ version: string; source: 'installed' | 'source'; ahead: number }>;
export function versionInfo(root: string, deps?: { fetcher?: typeof fetch; now?: () => number; readText?: (path: string) => Promise<string>; run?: (root: string, args: string[]) => Promise<string | null> }): Promise<{ version: string; source: 'installed' | 'source'; ahead: number; latest: string | null; url: string | null; newer: boolean }>;
export function resetVersionCache(): void;
