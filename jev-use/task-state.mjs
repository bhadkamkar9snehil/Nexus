import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,userInfo,hostname} from 'node:os';
export const taskBase=()=>process.env.NEXUS_TERMINAL_DIR??join(process.env.LOCALAPPDATA??join(homedir(),'AppData','Local'),'Nexus','terminal-sessions');
export const principal=()=>userInfo().username.toLowerCase();
export const validTaskId=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export async function taskMeta(id){
 if(!validTaskId(id))throw Error('Task not found');
 const m=JSON.parse(await readFile(join(taskBase(),id,'task.json'),'utf8'));
 if(m.version!==1||m.owner!==principal()||m.taskId!==id)throw Error('Task not found');
 return m;
}
export function taskStatus(state,stale=false){
 if(stale)return 'unconfirmed';
 if(state==='terminated')return 'cancelled';
 if(state==='exited')return 'completed';
 if(state==='error')return 'error';
 return 'working';
}
export async function listTaskViews(){
 let entries;
 try{entries=await readdir(taskBase(),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
 const rows=await Promise.all(entries.filter(x=>x.isDirectory()&&validTaskId(x.name)).slice(0,164).map(async x=>{
  try{
   const m=await taskMeta(x.name),dir=join(taskBase(),x.name);
   const s=await readFile(join(dir,'state.json'),'utf8').then(JSON.parse,()=>null);
   const live=!s||['starting','running'].includes(s.status);
   const heartbeat=live?await stat(join(dir,'heartbeat')).then(v=>v.mtimeMs,()=>m.createdAt):0;
   const state=taskStatus(s?.status,live&&Date.now()-heartbeat>10000);
   const cancelPending=live&&await stat(join(dir,'stop')).then(()=>true,()=>false);
   return {taskId:m.taskId,owner:m.owner,client:m.client,device:hostname(),type:'Terminal command',traceId:m.traceId,createdAt:m.createdAt,updatedAt:s?.ended_at??s?.started_at??m.createdAt,state,exitCode:s?.exit_code??null,pid:s?.pid??null,cancelPending,outputLimited:s?.output_limited??false};
  }catch{return null;}
 }));
 return rows.filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt);
}

export async function requestTaskStop(id){
 const m=await taskMeta(id),dir=join(taskBase(),id);
 const s=await readFile(join(dir,'state.json'),'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 if(s&&!['starting','running'].includes(s.status))return;
 if(!s&&Date.now()-m.createdAt>10000)throw Error('Task launch unconfirmed');
 await writeFile(join(dir,'stop'),'',{flag:'w'});
}
