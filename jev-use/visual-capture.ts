import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rmdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Driver } from './typescript/run.js';
import { selectWindow } from './window-selection.js';
import { withDesktopLock } from './desktop-lock.js';

const execute=promisify(execFile);
const MAX=16*1024*1024;
export function screenshotBytes(result:any):Buffer {
  if(result?.isError)throw new Error('Window capture failed');
  const images=Array.isArray(result?.content)?result.content.filter((c:any)=>c?.type==='image'&&c.mimeType==='image/png'):[];
  if(images.length!==1||typeof images[0].data!=='string'||images[0].data.length>Math.ceil(MAX/3)*4)throw new Error('Driver did not return one bounded PNG screenshot');
  const bytes=Buffer.from(images[0].data,'base64');
  if(!bytes.length||bytes.length>MAX||bytes.toString('base64')!==images[0].data)throw new Error('Invalid screenshot encoding');
  return bytes;
}
export async function captureDesktop(root:string,args:Record<string,any>){
  if(typeof args.app!=='string'||!args.app.trim()||args.app.length>120||!Number.isSafeInteger(args.window_id)||args.window_id<1)throw new Error('Exact application and window_id required');
  return withDesktopLock('visual_capture_desktop',async()=>{
    const bundled=join(root,'runtime','cua-driver.exe');
    const executable=existsSync(bundled)?bundled:join(process.env.LOCALAPPDATA??'','Programs','Cua','cua-driver','bin','cua-driver.exe');
    const client=new Client({name:'shared-jev-visual-capture',version:'1.0.0'});
    const transport=new StdioClientTransport({command:executable,args:['mcp','--socket','\\\\.\\pipe\\cua-driver'],stderr:'ignore'});
    try{
      await client.connect(transport);
      const session='shared-jev-visual-'+randomUUID();
      const driver=new Driver(client,session);
      const windows=(await driver.call('list_windows',{})).windows??[];
      const selected=selectWindow(windows,args.app,args.window_id);
      if(!selected.window||selected.minimized)throw new Error('Exact visible window not available');
      const {pid,window_id}=selected.window as {pid?:number;window_id?:number};
      if(!Number.isSafeInteger(pid)||!pid||pid<1||window_id!==args.window_id)throw new Error('Window identity changed');
      const result=await client.callTool({name:'get_window_state',arguments:{session,pid,window_id,full_output:true,include_accessibility_tree:false,include_screenshot:true}});
      return screenshotBytes(result);
    }finally{await transport.close();}
  });
}
export async function captureBrowser(root:string,args:Record<string,any>){
  const browser=args.browser??'chrome';
  if(!['chrome','edge'].includes(browser)||typeof args.session!=='string'||!/^[a-zA-Z0-9_-]{1,40}$/.test(args.session))throw new Error('Invalid existing browser session');
  const session='jev-'+browser+'-'+args.session, lock=join(root,'.sessions',session+'.lock');
  const cli=join(import.meta.dirname,'node_modules','@playwright','cli','playwright-cli.js');
  await mkdir(join(root,'.sessions'),{recursive:true});
  try{await mkdir(lock);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Browser session busy');throw e;}
  let dir:string|undefined;
  try{
    dir=await mkdtemp(join(tmpdir(),'nexus-capture-'));
    const call=async(...cmd:string[])=>{
      const {stdout}=await execute(process.execPath,[cli,'-s='+session,...cmd,'--json'],{cwd:import.meta.dirname,timeout:15000,maxBuffer:2*1024*1024,windowsHide:true});
      const result=JSON.parse(stdout);
      if(result.isError)throw new Error('Browser screenshot command failed');
      return result;
    };
    const list=await call('list');
    if(!list.browsers?.some((b:any)=>b.name===session&&b.status==='open'))throw new Error('Browser session not open');
    const path=join(dir,'capture.png');
    await call('screenshot','--filename='+path,'--type=png');
    const info=await stat(path);
    if(!info.isFile()||info.size<1||info.size>MAX)throw new Error('Browser screenshot exceeds bounds');
    return await readFile(path);
  }finally{try{if(dir)await rm(dir,{recursive:true,force:true});}finally{await rmdir(lock);}}
}
