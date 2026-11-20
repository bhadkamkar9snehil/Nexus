export type WebhookConfig = { events: string[]; projects: string[]; notify: string[]; forward: string[] };
export const eventKinds: string[];
export function loadWebhookConfig(root: string): Promise<WebhookConfig>;
export function configureWebhooks(root: string, change: Partial<WebhookConfig>): Promise<WebhookConfig>;
export function accepts(config: WebhookConfig, kind: string, project: string): boolean;
