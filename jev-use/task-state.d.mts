export type TaskMeta={version:1;taskId:string;owner:string;client:string;createdAt:number;traceId?:string;fingerprint:string};
export function taskBase():string;
export function principal():string;
export function validTaskId(id:unknown):id is string;
export function taskMeta(id:string):Promise<TaskMeta>;
export function taskStatus(state?:string,stale?:boolean):string;
export function listTaskViews():Promise<unknown[]>;

export function requestTaskStop(id:string):Promise<void>;
