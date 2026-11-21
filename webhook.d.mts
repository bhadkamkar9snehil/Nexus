export const events: { id: string; at: number; kind: string; project: string; title: string }[];
export const webhookPort: number;
export function webhookSecret(root: string): Promise<string>;
export function startWebhook(root: string): Promise<import("node:http").Server>;
