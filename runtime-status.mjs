import { readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const root = import.meta.dirname;
const exists = async p => { try { await access(p); return true; } catch { return false; } };
let previous = { at: performance.now(), cpu: process.cpuUsage() };
export async function runtimeStatus(inspect) {
  const checks = [];
  let system = {};
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-File',join(root,'Runtime-Status.ps1')], { windowsHide:true,timeout:8000,maxBuffer:65536 });
    system = JSON.parse(stdout);
  } catch { system.error = true; }
  const current = { at: performance.now(), cpu: process.cpuUsage() };
  const cpu = (current.cpu.user + current.cpu.system - previous.cpu.user - previous.cpu.system) / ((current.at - previous.at) * 1000) * 100;
  previous = current;
  checks.push({ id:'monitor', name:'Monitor', state:'healthy', summary:'Responding on this computer', detail: system.startup ? 'Windows sign-in launch is installed.' : 'Sign-in startup is not installed.', metrics:[{label:'Uptime',value:Math.floor(process.uptime()),unit:'seconds'},{label:'Memory',value:Math.round(process.memoryUsage().rss/1048576),unit:'MiB'},{label:'CPU',value:Math.round(cpu*100)/100,unit:'% of one core'}] });
  const managed=process.env.HARNESS_MONITOR_MANAGED==='1';
  checks.push({ id:'startup',name:'Availability',state:system.error?'unknown':system.startup&&managed?'healthy':'attention', summary:system.startup?'Automatic sign-in launch':'Manual launch only',detail:managed?'The hidden host restarts an unexpected server exit after three seconds. Intentional Stop is respected.':'Enable managed startup to recover unexpected exits.',metrics:[{label:'Task',value:system.taskState??'Unknown'},{label:'Recovery',value:managed?'3 seconds · up to999 exits':'Not observed'}] });
  const driver = existsSync(join(root,'runtime/cua-driver.exe')) ? join(root,'runtime/cua-driver.exe') : join(process.env.LOCALAPPDATA??'','Programs/Cua/cua-driver/bin/cua-driver.exe');
  try {
    const {stdout}=await execute(driver,['status'],{windowsHide:true,timeout:5000,maxBuffer:65536});
    const active=stdout.includes('daemon is running');
    checks.push({id:'desktop',name:'Windows desktop',state:active?'healthy':'attention',summary:active?'Cua Driver is running':'Cua Driver is stopped',detail:active?'Shared named pipe is available; a desktop action was not executed by this check.':'Start the installed Cua Driver sign-in task.',metrics:[{label:'Transport',value:'Shared Windows named pipe'}]});
  } catch { checks.push({id:'desktop',name:'Windows desktop',state:'attention',summary:'Driver could not be checked',detail:'Inspect the installed Cua Driver and its sign-in task.',metrics:[]}); }
  const installed=[];
  for(const [name,paths] of [['Chrome',[join(process.env.ProgramFiles??'','Google/Chrome/Application/chrome.exe'),join(process.env.LOCALAPPDATA??'','Google/Chrome/Application/chrome.exe')]],['Edge',[join(process.env['ProgramFiles(x86)']??'','Microsoft/Edge/Application/msedge.exe'),join(process.env.ProgramFiles??'','Microsoft/Edge/Application/msedge.exe')]]]) if(paths.some(existsSync)) installed.push(name);
  let warm=0;
  for(const name of ['ChromeProfile','EdgeProfile']) { try { const port=(await readFile(join(root,name,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]; if(/^\d{1,5}$/.test(port)) { const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(350)}); if(r.ok)warm++; } } catch {} }
  checks.push({id:'browser',name:'Browser automation',state:installed.length?'ready':'attention',summary:installed.length?installed.join(' and ')+' installed':'No supported browser found',detail:'Browsers launch on demand. Installed does not prove that a website task or login succeeds.',metrics:[{label:'Dedicated CDP sessions',value:warm},{label:'Execution',value:'CDP or Playwright CLI'}]});
  let search;
  try { search=await inspect('search_status'); } catch { search={status:'error'}; }
  checks.push({id:'search',name:'File and content search',state:search.running?'healthy':search.status==='idle'?'idle':'attention',summary:search.running?'UFFS index service is available':search.status==='idle'?'Index is idle; starts on demand':'Search status unavailable',detail:'UFFS finds names and metadata. Ripgrep searches contents. This check does not warm the index.',metrics:[{label:'Broker',value:system.broker??'Unknown'},{label:'Indexed records',value:search.records??null},{label:'Last warm records',value:search.drives?search.drives.reduce((n,d)=>n+(d.records_when_warm??0),0):null},{label:'Index memory',value:search.workingSetBytes==null?null:Math.round(search.workingSetBytes/1048576),unit:'MiB'}]});
  const key=await exists(join(root,'secrets/computeruse_1.xml')) || Boolean(process.env.TYPESAFE_API_KEY);
  checks.push({id:'jev',name:'Jev decisions',state:key?'configured':'attention',summary:key?'Local credential enrolled':'Credential is missing',detail:key?'No paid API request was made. Authentication and provider availability are not tested.':'Enroll the TypeSafe credential using the masked local prompt.',metrics:[{label:'Provider',value:'TypeSafe'},{label:'API check',value:'Not requested'}]});
  const agents=[];
  const codex=join(process.env.USERPROFILE??'','.codex/config.toml');
  try { const c=await readFile(codex,'utf8'); agents.push({name:'Codex',registered:/\[mcp_servers\.shared_jev\]/.test(c)}); } catch {agents.push({name:'Codex',registered:false});}
  try { const c=JSON.parse(await readFile(join(process.env.USERPROFILE??'','.claude.json'),'utf8')); agents.push({name:'Claude Code',registered:Boolean(c.mcpServers?.shared_jev)}); } catch {agents.push({name:'Claude Code',registered:false});}
  return {checkedAt:Date.now(),checks,agents,scope:'Read-only local observations. No browser, desktop action or paid Jev call was performed.'};
}
