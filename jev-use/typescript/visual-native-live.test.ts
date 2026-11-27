import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Driver} from './run.js';
import {captureDesktop} from '../visual-capture.js';
import sharp from 'sharp';
test('live exact native window capture with a synthetic fixture',{skip:process.env.NEXUS_VISUAL_NATIVE_LIVE_TEST!=='1',timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'nexus-native-fixture-'));
 const title='Nexus Visual Fixture '+randomUUID().slice(0,8);
 const script=join(dir,'fixture.ps1');
 await writeFile(script,`Add-Type -AssemblyName System.Windows.Forms
$f=New-Object Windows.Forms.Form
$f.Text='${title}'
$f.Width=640
$f.Height=400
$l=New-Object Windows.Forms.Label
$l.Text='NEXUS READY'
$l.AutoSize=$true
$l.Font=New-Object Drawing.Font('Arial',36)
$f.Controls.Add($l)
$t=New-Object Windows.Forms.Timer
$t.Interval=30000
$t.Add_Tick({$t.Stop();$f.Close()})
$t.Start()
[void]$f.ShowDialog()
`);
 const fixture=spawn('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-File',script],{windowsHide:true,stdio:'ignore'});
 const exe=join(process.env.LOCALAPPDATA!,'Programs','Cua','cua-driver','bin','cua-driver.exe');
 const transport=new StdioClientTransport({command:exe,args:['mcp','--socket','\\\\.\\pipe\\cua-driver'],stderr:'ignore'});
 const client=new Client({name:'visual-native-fixture',version:'1.0.0'});
 try{
  await client.connect(transport);
  const driver=new Driver(client,'visual-native-fixture-'+randomUUID());
  let w:any;
  for(let i=0;i<12;i++){const windows=(await driver.call('list_windows',{})).windows??[];w=windows.find((x:any)=>x.title===title&&x.is_on_screen&&!x.minimized);if(w)break;await new Promise(r=>setTimeout(r,500));}
  assert.ok(w,'Synthetic fixture window not available in interactive session');
  const bytes=await captureDesktop(join(import.meta.dirname,'..','..'),{app:title,window_id:w.window_id});
  const meta=await sharp(bytes).metadata();
  assert.equal(meta.format,'png');assert.ok(meta.width&&meta.height);console.log(JSON.stringify({width:meta.width,height:meta.height,bytes:bytes.length}));
 }finally{await transport.close();fixture.kill();await rm(dir,{recursive:true,force:true});}
});
