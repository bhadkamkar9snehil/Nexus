export function saveSession(root: string, id: string, change: object): Promise<object>;
export function describeSessions(root: string, own?: boolean): Promise<string>;
export function readSession(root: string, id: string): Promise<object | null>;
export function clip(text: unknown, n: number): string;

export type DiscoveredSession = { id: string; host: string; at: number; cwd: string; folder: string; claim: string; topic: string; summary: string; transcriptPath: string };
export function discoverSessions(root: string, options?: { maxAgeMs?: number; limit?: number; home?: string; includeHosts?: boolean }): Promise<DiscoveredSession[]>;
export function selectWorkspace(sessions: DiscoveredSession[], query?: string, fallback?: string): Promise<string>;
export function formatSessionContext(sessions: DiscoveredSession[], options?: { own?: boolean; maxChars?: number }): string;
