export const events: { id: string; at: number; kind: string; project: string; title: string }[];
export const webhookPort: number;
export function webhookSecret(root: string): Promise<string>;
export function summarize(kind: string, body: any): { project: string; title: string; tag?: string };
export function startWebhook(root: string, options?: { port?: number; host?: string }): Promise<import("node:http").Server>;
