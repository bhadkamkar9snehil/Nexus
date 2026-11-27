import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
const root=resolve(import.meta.dirname,'..');
test('WebView2 virtual-host HTML references only real packaged UI files',async()=>{
 const html=await readFile(join(root,'desktop.html'),'utf8');
 const matches=[...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"[^>]*>/g)];
 assert.deepEqual(matches.map(m=>m[1]),['./monitor-ui/dist/app.css','./monitor-ui/dist/app.js']);
 for(const [,url] of matches){
  for(const base of ['https://app.nexus.local/desktop.html','http://127.0.0.1:8769/']){
   const path=new URL(url,base).pathname.slice(1);
   const file=resolve(root,path);
   assert.equal(relative(root,file).replaceAll('\\','/'),path);
   const info=await stat(file);assert.ok(info.isFile()&&info.size>0);
  }
 }
 const css=await readFile(join(root,'monitor-ui/dist/app.css'),'utf8');
 const fonts=[...css.matchAll(/url\(["']?([^)"']+\.woff2)["']?\)/g)].map(m=>m[1]);
 assert.equal(fonts.length,2);
 for(const url of fonts){
  const path=new URL(url,'https://app.nexus.local/monitor-ui/dist/app.css').pathname;
  assert.match(path,/^\/monitor-ui\/dist\/geist(?:-mono)?\.woff2$/);
  assert.ok((await stat(join(root,path.slice(1)))).size>0);
 }
 assert.match(html,/id="nexus-startup-message"/);
 assert.match(html,/onerror="nexusStartupFailed\(\)"/);
});
test('monitor retains legacy URLs and supports packaged asset URLs',async()=>{
 const src=await readFile(join(root,'monitor.mjs'),'utf8');
 assert.ok(src.includes("['/assets/', '/monitor-ui/dist/']"));
 assert.ok(src.includes('Object.hasOwn(assets, req.url)'));
});
