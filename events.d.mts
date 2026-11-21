export type EventRow = { seq: number; eventId: string; name: string; timestamp: string; data: Record<string, unknown> };
export function emit(root: string, event: { name: string; eventId?: string; data: Record<string, unknown> }): Promise<EventRow>;
export function cursorOf(seq: number): string;
export function parseCursor(cursor: string | null | undefined): number;
export function readEvents(root: string, query: { name: string; afterSeq: number; match?: (data: Record<string, unknown>) => boolean }): Promise<{ head: number; first: number; rows: EventRow[] }>;
