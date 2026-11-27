import {createHash,randomUUID} from 'node:crypto';
import {open,link,unlink,stat} from 'node:fs/promises';
import {isAbsolute,basename} from 'node:path';
import {guardPath} from './read-text-file.js';
const MAX=256*1024;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const check=(p:string)=>{if(typeof p!=='string'||!isAbsolute(p)||/[:]/.test(p.slice(2)))throw new Error('Absolute regular file path required');};
export async function binaryTransfer(args:{action:string;path:string;data?:string;sha256?:string;size?:number;allowedRoots?:string[]}){
 const {action,path}=args;check(path);
 if(action==='download'){
  const resolved=await guardPath(path,args.allowedRoots,'NEXUS_READ_ROOTS');
  const f=await open(resolved,'r');
  try{const info=await f.stat();if(!info.isFile()||info.size>MAX)throw new Error('Regular file, maximum 256 KiB');
   const b=Buffer.alloc(info.size);const result=await f.read(b,0,b.length,0);
   const after=await f.stat();if(result.bytesRead!==b.length||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw new Error('File changed while reading');
   return {status:'done',action,name:basename(resolved),bytes:b.length,sha256:hash(b),blob:b.toString('base64'),decisions:0};
  }finally{await f.close();}
 }
 if(action!=='upload')throw new Error('Invalid action');
 if(typeof args.data!=='string'||args.data.length>Math.ceil(MAX/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data))throw new Error('Invalid base64 or size limit exceeded');
 const b=Buffer.from(args.data,'base64');
 if(b.length>MAX||b.toString('base64')!==args.data||args.size!==b.length||typeof args.sha256!=='string'||hash(b)!==args.sha256.toLowerCase())throw new Error('Size or SHA-256 mismatch');
 const resolved=await guardPath(path,args.allowedRoots,'NEXUS_WRITE_ROOTS',true);
 try{await stat(resolved);throw new Error('Destination exists');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const temp=resolved+'.nexus-'+randomUUID()+'.tmp';
 const f=await open(temp,'wx');
 try{try{await f.writeFile(b);await f.sync();}finally{await f.close();}
  // Atomic no-overwrite publish; never replace an existing destination.
  await link(temp,resolved);
 }finally{await unlink(temp).catch(()=>{});}
 return {status:'done',action,name:basename(resolved),bytes:b.length,sha256:hash(b),decisions:0};
}
