export function watchManage(root:string,args:Record<string,any>):Promise<any>;
export function runVisualWatches(root:string,options:{now?:number;evaluate:(args:Record<string,any>)=>Promise<any>;emitEvent?:(root:string,event:Record<string,any>)=>Promise<any>}):Promise<void>;
export function startVisualWatches(root:string,options?:{log?:(message:string)=>void}):()=>void;
