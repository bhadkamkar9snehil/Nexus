export function firewall(options?: { create?: boolean }): Promise<{ admin: boolean; open: boolean; created: boolean; port: number; error?: string }>;
