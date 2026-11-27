import {randomBytes,randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {hostname} from 'node:os';
export const traceId=()=>randomBytes(16).toString('hex');
export const spanId=()=>randomBytes(8).toString('hex');
export const validTrace=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v)&&!/^[0]+$/.test(v);
export const validSpan=v=>typeof v==='string'&&/^[a-f0-9]{16}$/.test(v)&&!/^[0]+$/.test(v);
export const validMessage=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const safePeer=v=>typeof v==='string'&&/^[\w.-]{1,40}$/.test(v)?v:undefined;
const safeKind=v=>['mail','chat'].includes(v)?v:undefined;
const outcomes=new Set(['delivered','received','refused','transport_error','storage_error','disabled','not_chat','peer_disabled','hop_limit','no_agent','finished','replied','agent_error','responder_error']);
export function beginPeerSpan(root,operation,{peer,kind,trace,parent,messageId,hop,bytes}={}){
 const id=randomUUID(),span=spanId(),started=Date.now(),t=performance.now();
 const base={id,tool:operation,source:'peer',device:hostname().slice(0,64),traceId:validTrace(trace)?trace:traceId(),spanId:span,parentSpanId:validSpan(parent)?parent:undefined,messageId:validMessage(messageId)?messageId:undefined,peer:safePeer(peer),messageKind:safeKind(kind),hop:Number.isInteger(hop)&&hop>=0&&hop<=20?hop:undefined,requestBytes:Number.isSafeInteger(bytes)&&bytes>=0?bytes:undefined,backend:'peer'};
 const write=details=>{try{appendFileSync(join(root,'runs.jsonl'),JSON.stringify({...base,at:Date.now(),started,...details})+'\n');}catch{/* telemetry must not interrupt delivery */}};
 write({status:'running'});
 let done=false;
 return {traceId:base.traceId,spanId:span,finish(status,outcome,extra={}){if(done)return;done=true;write({status:['passed','blocked','error'].includes(status)?status:'error',outcome:outcomes.has(outcome)?outcome:'responder_error',ms:Math.round(performance.now()-t),httpStatus:Number.isInteger(extra.httpStatus)?extra.httpStatus:undefined,queueMs:Number.isFinite(extra.queueMs)?Math.max(0,Math.round(extra.queueMs)):undefined,executionMs:Number.isFinite(extra.executionMs)?Math.max(0,Math.round(extra.executionMs)):undefined,responder:typeof extra.responder==='string'&&['claude','codex','custom'].includes(extra.responder)?extra.responder:undefined,responseBytes:Number.isSafeInteger(extra.responseBytes)&&extra.responseBytes>=0?extra.responseBytes:undefined});}};
}
