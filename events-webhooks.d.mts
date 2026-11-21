export const CODES: Record<string, number>;
export class EventError extends Error { code: number; data?: Record<string, unknown>; constructor(name: string, data?: Record<string, unknown>); }
export function post(url: string, headers: Record<string, string>, body: string, options?: { timeoutMs?: number }): Promise<{ status?: number; body?: string; error?: string }>;
export function validSecret(secret: unknown): boolean;
export function signHeaders(input: { secrets: string[]; subscriptionId: string; messageId: string; body: string }): Record<string, string>;
export function subscriptionId(principal: string, url: string, name: string, args?: Record<string, unknown>): string;
export function subscribe(root: string, request: { principal: string; name: string; args?: Record<string, unknown>; url: string; secret: string; ttlMs?: number | null; cursor?: string | null; maxAgeMs?: number; head: number; first: number }): Promise<{ id: string; refreshBefore: string | null; cursor: string; truncated: boolean; deliveryStatus?: Record<string, unknown> }>;
export function unsubscribe(root: string, request: { principal: string; name: string; args?: Record<string, unknown>; url: string }): Promise<void>;
export function startEventDelivery(root: string, options?: { intervalMs?: number; log?: (message: string) => void }): () => void;
