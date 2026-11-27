import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const TASKS='io.modelcontextprotocol/tasks';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('Tasks extension: reconnect, result, idempotency, cancellation and legacy fallback',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-task-wire-'));
 let c:{close:()=>Promise<void>;request:(method:string,params:Record<string,unknown>)=>Promise<any>;capabilities:any}|undefined;
 const connect=async(native:boolean)=>{
  // SDK 2.4.0 core client cannot decode extension-defined resultType "task".
  // Exercise the actual 2026-07-28 JSON-RPC wire with the SDK stdio transport.
  const transport=new StdioClientTransport({command:process.execPath,args:[process.env.NEXUS_TEST_START??join(import.meta.dirname,'..','start.mjs')],stderr:'ignore',env:{...process.env,NEXUS_TERMINAL_DIR:root,HARNESS_MONITOR_OBSERVATION:'1'} as Record<string,string>});
  await transport.start();
  let seq=0;
  const request=(method:string,params:Record<string,unknown>)=>new Promise<any>((resolve,reject)=>{
   const id=++seq;
   const timer=setTimeout(()=>reject(Error('RPC timeout '+method)),15000);
   transport.onmessage=(message:any)=>{if(message.id!==id)return;clearTimeout(timer);if(message.error)reject(Error(message.error.code+': '+message.error.message));else resolve(message.result);};
   transport.send({jsonrpc:'2.0',id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'task-wire-test',version:'1.0'},'io.modelcontextprotocol/clientCapabilities':native?{extensions:{[TASKS]:{}}}:{}}}}).catch(e=>{clearTimeout(timer);reject(e);});
  });
  try{const discovery=await request('server/discover',{});return {request,capabilities:discovery.capabilities,close:()=>transport.close()};}catch(e){await transport.close();throw e;}
 };
 const req=async(method:string,params:Record<string,unknown>)=>await c!.request(method,params);
 const poll=async(id:string)=>{for(let i=0;i<50;i++){const v=await req('tasks/get',{taskId:id});if(v.status!=='working')return v;await wait(250);}throw Error('Task timed out');};
 const start=(args:Record<string,unknown>)=>req('tools/call',{name:'nexus_start_task',arguments:args});
 try{
  c=await connect(true);
  assert.deepEqual(c.capabilities?.extensions?.[TASKS],{});
  const args={command:'Start-Sleep -Milliseconds 1200; Write-Output NEXUS_TASK_OK',shell:'powershell',cwd:root,idempotency_key:randomUUID()};
  const t=await start(args);assert.equal(t.resultType,'task',JSON.stringify(t));assert.equal(typeof t.taskId,'string');
  const dup=await start(args);assert.equal(dup.taskId,t.taskId);assert.equal((await readdir(root)).length,1);
  const mismatch=await start({...args,command:'Write-Output SHOULD_NOT_RUN'});assert.equal(mismatch.isError,true);
  await c.close();c=await connect(true);
  const end=await poll(t.taskId);assert.equal(end.resultType,'complete');assert.equal(end.status,'completed');assert.equal(end.result.isError,false);assert.match(end.result.content[0].text,/NEXUS_TASK_OK/);
  const fail=await start({...args,command:'exit 7',idempotency_key:randomUUID()});const failed=await poll(fail.taskId);assert.equal(failed.status,'completed');assert.equal(failed.result.isError,true);
  const cancel=await start({...args,command:'Start-Sleep -Seconds 30',idempotency_key:randomUUID()});assert.equal((await req('tasks/cancel',{taskId:cancel.taskId})).resultType,'complete');const cancelled=await poll(cancel.taskId);assert.equal(cancelled.status,'cancelled',JSON.stringify(cancelled));
  assert.equal((await req('tasks/update',{taskId:t.taskId,inputResponses:{unknown:{}}})).resultType,'complete');
  await assert.rejects(req('tasks/get',{taskId:randomUUID()}),/Task not found|32602/);
  await c.close();c=await connect(false);
  await assert.rejects(req('tasks/get',{taskId:t.taskId}),/Missing required client capability|32021/);
  const legacy=await start({...args,command:'Write-Output LEGACY_OK',idempotency_key:randomUUID()});assert.notEqual(legacy.resultType,'task');const fallback=JSON.parse(legacy.content[0].text);assert.ok(fallback.task_id);
  await wait(1500);
 }finally{await c?.close();await wait(500);await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
