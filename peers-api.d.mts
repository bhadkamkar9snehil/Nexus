export function handleApi(root: string, method: string, url: URL, body: Record<string, unknown>, options?: { run?: () => Promise<unknown> }): Promise<{ status: number; json: unknown }>;
