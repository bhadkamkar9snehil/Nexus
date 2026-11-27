export function saveSession(root: string, id: string, change: object): Promise<object>;
export function describeSessions(root: string, own?: boolean): Promise<string>;
export function readSession(root: string, id: string): Promise<object | null>;
export function clip(text: unknown, n: number): string;
