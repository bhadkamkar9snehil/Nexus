import {ProtocolError,type Server} from '@modelcontextprotocol/server';
import * as z from 'zod';
import {taskMeta,validTaskId,requestTaskStop} from './task-state.mjs';
import {readProcessOutput,terminalTaskState} from './terminal-sessions.js';
export const TASKS='io.modelcontextprotocol/tasks';
const key='io.modelcontextprotocol/clientCapabilities';
export function supportsTasks(envelope:unknown,meta:unknown){
 const e=envelope as Record<string,any>|undefined,m=meta as Record<string,any>|undefined;
 // Per-request metadata only, never the legacy initialized capabilities.
 const x=m?.[key]?.extensions?.[TASKS]??e?.clientCapabilities?.extensions?.[TASKS]??e?.[key]?.extensions?.[TASKS];
 return !!x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===0;
}
const requireCapability=(ctx:any,params:any)=>{
 if(!supportsTasks(ctx.mcpReq.envelope,params?._meta))throw new ProtocolError(-32021,'Missing required client capability',{requiredCapabilities:{extensions:{[TASKS]:{}}}});
};
const missing=()=>new ProtocolError(-32602,'Task not found or expired');
async function owned(id:string){if(!validTaskId(id))throw missing();try{return await taskMeta(id);}catch{throw missing();}}
export async function getTask(id:string,seed=false){
 const meta=await owned(id);
 const s=await terminalTaskState(id).catch(()=>null);
 const now=Date.now();
 const createdAt=new Date(meta.createdAt).toISOString();
 const lastUpdatedAt=new Date(s?.ended_at??s?.started_at??meta.createdAt).toISOString();
 const common={taskId:id,createdAt,lastUpdatedAt,ttlMs:s?.ended_at?Math.max(0,s.ended_at+7*86400000-meta.createdAt):null,pollIntervalMs:1000};
 if(!s){
  if(now-meta.createdAt<10000)return {...common,status:'working' as const,statusMessage:'Starting managed terminal worker'};
  return {...common,status:'failed' as const,error:{code:-32603,message:'Worker launch not confirmed; inspect the terminal session before retrying.'}};
 }
 if(s.status==='starting'||s.status==='running')return {...common,status:'working' as const,statusMessage:'Managed terminal command active'};
 if(s.status==='terminated')return {...common,status:'cancelled' as const,statusMessage:'Managed worker confirmed termination'};
 // A nonzero command exit is a completed tool result with isError, not a JSON-RPC failure.
 if(s.status==='error')return {...common,status:'completed' as const,statusMessage:'Terminal worker reported an error',result:{isError:true,content:[{type:'text',text:JSON.stringify({session_id:id,state:s.status,error:s.error,exit_code:s.exit_code})}]}};
 if(s.status!=='exited')return {...common,status:'failed' as const,error:{code:-32603,message:'Unknown terminal worker state'}};
 const page=await readProcessOutput({session_id:id,offset:0,length:50});
 return {...common,status:'completed' as const,statusMessage:s.exit_code===0?'Command exited successfully':'Command exited with error',result:{isError:s.exit_code!==0,content:[{type:'text',text:JSON.stringify(page)}]}};
}
export async function taskHandle(id:string){
 const t=await getTask(id,true);
 // A seed may be terminal; final result can always be retrieved by tasks/get.
 const {taskId,status,createdAt,lastUpdatedAt,ttlMs,pollIntervalMs}=t;
 return {resultType:'task' as const,taskId,status,createdAt,lastUpdatedAt,ttlMs,pollIntervalMs,statusMessage:'statusMessage' in t?t.statusMessage:undefined};
}
export function attachTasks(server:Server){
 server.registerCapabilities({extensions:{[TASKS]:{}}});
 const id=z.object({taskId:z.string().max(36)}).passthrough();
 const result=z.object({}).passthrough();
 server.setRequestHandler('tasks/get',{params:id,result},async(params,ctx)=>{requireCapability(ctx,params);return {resultType:'complete',...await getTask(params.taskId)};});
 server.setRequestHandler('tasks/update',{params:id,result},async(params,ctx)=>{requireCapability(ctx,params);await owned(params.taskId);const responses=(params as Record<string,unknown>).inputResponses??ctx.mcpReq.inputResponses;if(!responses||typeof responses!=='object'||Array.isArray(responses))throw new ProtocolError(-32602,'inputResponses must be an object');/* Terminal tasks never issue input requests. Ignore unknown response keys. */return {resultType:'complete'};});
 server.setRequestHandler('tasks/cancel',{params:id,result},async(params,ctx)=>{requireCapability(ctx,params);await owned(params.taskId);await requestTaskStop(params.taskId);return {resultType:'complete'};});
}
