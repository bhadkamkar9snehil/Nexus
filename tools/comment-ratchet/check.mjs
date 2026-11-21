import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = path.join(root, 'tools/comment-ratchet/baseline.json');
const parsePsPath = path.join(root, 'tools/comment-ratchet/parse-powershell.ps1');
const extensions = new Set(['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs','.ps1','.psm1','.psd1','.cs','.css','.html','.htm','.xaml','.csproj','.props','.targets','.iss','.sql','.jsonc','.json5','.yml','.yaml','.sh','.cmd','.bat']);
const special = new Set(['.gitignore','.gitattributes','.editorconfig']);
const tsExt = new Set(['.ts','.tsx','.mts','.cts','.js','.jsx','.mjs','.cjs']);
const psExt = new Set(['.ps1','.psm1','.psd1']);
const xmlExt = new Set(['.xaml','.csproj','.props','.targets']);
const generated = new Set(['jev-browse/bundled/cli.mjs','jev-browse/bundled/mcp.mjs']);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const normalize = s => s.replace(/\s+/g, ' ').trim();

function files() {
  const data = execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8',maxBuffer:20000000});
  return [...new Set(data.split('\0').filter(Boolean))].filter(f => {
    const ext = path.extname(f).toLowerCase();
    return (extensions.has(ext) || special.has(path.basename(f))) && fs.existsSync(path.join(root,f)) &&
      !f.split(/[\\/]/).some(dir => ['node_modules','bin','obj','dist','coverage'].includes(dir));
  }).sort();
}

function tsComments(filename, source, ts) {
  const kind = /\.([jt]sx)$/.test(filename) ? ts.ScriptKind.TSX : /\.(?:[cm]?ts)$/.test(filename) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const tree = ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,kind);
  const found = new Map();
  const add = ranges => {
    for (const item of ranges || []) if (item.pos < item.end) {
      found.set(item.pos+':'+item.end,{start:item.pos,end:item.end});
    }
  };
  add(ts.getLeadingCommentRanges(source,0));
  const visit = node => {
    add(ts.getLeadingCommentRanges(source,node.pos));
    add(ts.getTrailingCommentRanges(source,node.end));
    ts.forEachChild(node,visit);
  };
  visit(tree);
  add(ts.getTrailingCommentRanges(source,tree.end));
  return [...found.values()].sort((a,b)=>a.start-b.start);
}

function xmlComments(source) {
  const comments = [];
  let pos = 0;
  while ((pos=source.indexOf('<!--',pos)) !== -1) {
    let end=source.indexOf('-->',pos+4);
    if (end === -1) throw Error('Unclosed XML comment');
    comments.push({start:pos,end:end+3}); pos=end+3;
  }
  return comments;
}

function lexicalComments(source, filename) {
  const ext=path.extname(filename).toLowerCase();
  const lineHash = ['.yml','.yaml','.sh'].includes(ext) || special.has(path.basename(filename));
  const sql=ext==='.sql', inno=ext==='.iss', batch=['.cmd','.bat'].includes(ext);
  const css=ext==='.css';
  const result=[];
  let i=0, lineStart=0, quoted='', verbatim=false, raw=0;
  const beginLine=()=>!source.slice(lineStart,i).trim();
  const add=(start,end)=>{result.push({start,end});i=end;};
  while(i<source.length) {
    const c=source[i], n=source[i+1];
    if(c==='\n'){lineStart=i+1;i++;continue;}
    if(quoted) {
      if(raw) {if(source.slice(i,i+raw)==='"'.repeat(raw)){i+=raw;quoted='';raw=0;}else i++;continue;}
      if(verbatim && c==='"' && n==='"'){i+=2;continue;}
      if(!verbatim && c==='\\'){i+=2;continue;}
      if(c===quoted){quoted='';verbatim=false;}
      i++;continue;
    }
    if(batch && beginLine() && /^(?:rem(?:\s|$)|::)/i.test(source.slice(i))){
      let end=source.indexOf('\n',i);add(i,end<0?source.length:end);continue;
    }
    if(inno && beginLine() && c===';'){
      let end=source.indexOf('\n',i);add(i,end<0?source.length:end);continue;
    }
    if(lineHash && c==='#' && (beginLine() || /\s/.test(source[i-1]||''))){
      if(!(ext==='.sh' && i===0 && n==='!')){
        let end=source.indexOf('\n',i);add(i,end<0?source.length:end);continue;
      }
    }
    if(!lineHash && !batch && !css && c==='/' && n==='/'){
      let end=source.indexOf('\n',i);add(i,end<0?source.length:end);continue;
    }
    if(sql && c==='-' && n==='-'){
      let end=source.indexOf('\n',i);add(i,end<0?source.length:end);continue;
    }
    if(!lineHash && !batch && c==='/' && n==='*'){
      const end=source.indexOf('*/',i+2);
      if(end<0)throw Error('Unclosed block comment in '+filename);
      add(i,end+2);continue;
    }
    if(inno && c==='(' && n==='*'){
      const end=source.indexOf('*)',i+2);
      if(end<0)throw Error('Unclosed Pascal comment in '+filename);
      add(i,end+2);continue;
    }
    if(c==='@' && n==='"' && !lineHash){quoted='"';verbatim=true;i+=2;continue;}
    if(c==='"' && n==='"' && source[i+2]==='"' && !lineHash){
      let count=3;while(source[i+count]==='"')count++;
      quoted='"';raw=count;i+=count;continue;
    }
    if(c==='"' || c==="'" || (css && c.charCodeAt(0)===96)){quoted=c;i++;continue;}
    if(sql && c==='['){const end=source.indexOf(']',i+1);i=end<0?source.length:end+1;continue;}
    i++;
  }
  return result;
}

function htmlComments(source,ts) {
  const ranges=xmlComments(source);
  const tags=/<(script|style)\b[^>]*>/gi;
  let m;
  while((m=tags.exec(source))) {
    const offset=tags.lastIndex, name=m[1].toLowerCase();
    const closing=new RegExp('</'+name+'\\s*>','ig');
    closing.lastIndex=offset;
    const end=closing.exec(source);
    if(!end)continue;
    const inner=source.slice(offset,end.index);
    const nested=name==='script'?tsComments('inline.js',inner,ts):lexicalComments(inner,'inline.css');
    for(const r of nested)ranges.push({start:r.start+offset,end:r.end+offset});
    tags.lastIndex=closing.lastIndex;
  }
  return ranges.sort((a,b)=>a.start-b.start);
}

function psComments(entries) {
  if(!entries.length)return {};
  const request=JSON.stringify({files:entries.map(e=>({path:e.file,absolutePath:path.join(root,e.file)}))});
  const p=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',parsePsPath],
    {input:request,encoding:'utf8',maxBuffer:16000000,windowsHide:true});
  if(p.status!==0)throw Error('PowerShell AST error: '+(p.stderr||p.stdout||p.error));
  const rows=JSON.parse(p.stdout||'[]'), grouped={};
  for(const r of (Array.isArray(rows)?rows:[rows])){
    if(r)(grouped[r.path] ||= []).push({start:r.start,end:r.end});
  }
  return grouped;
}

function evaluate(source,ranges,filename) {
  ranges.sort((a,b)=>a.start-b.start);
  for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)throw Error('Overlapping comment tokens');
  const mask=source.split('');
  for(const r of ranges)for(let i=r.start;i<r.end;i++)if(mask[i]!=='\r'&&mask[i]!=='\n')mask[i]=' ';
  const code=mask.join('').split(/\r?\n/),original=source.split(/\r?\n/);
  const starts=[0];
  for(let i=0;i<source.length;i++)if(source[i]==='\n')starts.push(i+1);
  function lineAt(offset) {
    let low=0,high=starts.length-1;
    while(low<high){const mid=Math.ceil((low+high)/2);if(starts[mid]<=offset)low=mid;else high=mid-1;}
    return low;
  }
  const only=new Set(),inline=new Set(),comments=[];
  for(const r of ranges) {
    const first=lineAt(r.start),last=lineAt(Math.max(r.start,r.end-1));
    for(let line=first;line<=last;line++){
      if(code[line].trim())inline.add(line);
      else if(original[line].trim())only.add(line);
    }
    const same=normalize(code[first]||'');
    let before='',after='';
    for(let j=first-1;j>=0;j--)if(code[j].trim()){before=normalize(code[j]);break;}
    for(let j=last+1;j<code.length;j++)if(code[j].trim()){after=normalize(code[j]);break;}
    const text=source.slice(r.start,r.end);
    const protectedCandidate=generated.has(filename) || /^#!|^#requires\b|^\/\/\/\s*<reference\b|(?:SPDX-License-Identifier|copyright\b|licensed under\b|@license\b|eslint-disable|@ts-(?:nocheck|check|ignore|expect-error))/i.test(text.trim());
    comments.push({line:first+1,endLine:last+1,inline:!!same,text,
      protectedCandidate,fingerprint:sha(text+'\n'+sha(JSON.stringify([before,same,after])))});
  }
  return {lines:source.length?original.length-(source.endsWith('\n')?1:0):0,commentOnlyLines:only.size,inlineCommentLines:inline.size,comments};
}

async function collect() {
  const candidate=path.join(root,'jev-use/node_modules/typescript/lib/typescript.js');
  if(!fs.existsSync(candidate))throw Error('TypeScript parser missing. Run npm ci --prefix jev-use --ignore-scripts in an isolated checkout.');
  const module=await import(pathToFileURL(candidate).href),ts=module.default||module;
  const entries=files().map(file=>({file,source:fs.readFileSync(path.join(root,file),'utf8')}));
  const powershell=psComments(entries.filter(e=>psExt.has(path.extname(e.file).toLowerCase())));
  const result={};
  for(const e of entries) {
    const ext=path.extname(e.file).toLowerCase();
    const ranges=tsExt.has(ext)?tsComments(e.file,e.source,ts):
      psExt.has(ext)?(powershell[e.file]||[]):
      ['.html','.htm'].includes(ext)?htmlComments(e.source,ts):
      xmlExt.has(ext)?xmlComments(e.source):lexicalComments(e.source,e.file);
    result[e.file]=evaluate(e.source,ranges,e.file);
  }
  return result;
}

function summary(files) {
  const result={sourceFiles:0,sourceLines:0,comments:0,commentOnlyLines:0,inlineCommentLines:0,protectedCandidates:0,extensions:{}};
  for(const [file,data] of Object.entries(files)){
    result.sourceFiles++;result.sourceLines+=data.lines;result.comments+=data.comments.length;
    result.commentOnlyLines+=data.commentOnlyLines;result.inlineCommentLines+=data.inlineCommentLines;
    result.protectedCandidates+=data.comments.filter(c=>c.protectedCandidate).length;
    const key=path.extname(file).toLowerCase()||path.basename(file);
    const stat=(result.extensions[key] ||= {files:0,comments:0,sourceLines:0});
    stat.files++;stat.comments+=data.comments.length;stat.sourceLines+=data.lines;
  }
  return result;
}

function verify(current,base) {
  const violations=[], next={};
  for(const [file,data] of Object.entries(current)){
    if (generated.has(file)) {
      next[file]=base.files[file]||{comments:[]};
      continue;
    }
    const allowed=base.files[file]?.comments||[];
    const counts=new Map();
    for(const r of allowed)counts.set(r.fingerprint,(counts.get(r.fingerprint)||0)+1);
    const retained=[];
    for(const r of data.comments){
      const n=counts.get(r.fingerprint)||0;
      if(!n)violations.push(file+':'+r.line+': new, changed, or moved comment');
      else {counts.set(r.fingerprint,n-1);retained.push(r);}
    }
    next[file]={comments:retained};
  }
  return {violations,next};
}

async function main() {
  const mode=process.argv[2]||'check';
  if(!['audit','init','shrink','check'].includes(mode))throw Error('Use audit|init|shrink|check [--json] [--path directory]');
  const all=await collect(),stats=summary(all);
  if(mode==='audit'){
    const idx=process.argv.indexOf('--path');
    const prefix=idx>=0?process.argv[idx+1].replace(/\\/g,'/'):null;
    const selected=prefix?Object.fromEntries(Object.entries(all).filter(([name])=>name.startsWith(prefix))):all;
    if(process.argv.includes('--json'))console.log(JSON.stringify({stats:summary(selected),files:selected},null,2));
    else {
      console.log(JSON.stringify(summary(selected),null,2));
      console.log(Object.entries(selected).filter(([,v])=>v.comments.length)
        .sort((a,b)=>b[1].comments.length-a[1].comments.length).slice(0,35)
        .map(([file,v])=>file+': '+v.comments.length).join('\n'));
    }
    return;
  }
  if(mode==='init'){
    if(fs.existsSync(baselinePath))throw Error('Baseline exists: never increase it automatically');
    const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
    const baseline={schema:1,sourceCommit:commit,files:Object.fromEntries(
      Object.entries(all).map(([file,v])=>[file,{comments:v.comments}]))};
    fs.writeFileSync(baselinePath,JSON.stringify(baseline,null,2)+'\n');
    console.log('Baseline created: '+JSON.stringify(stats));return;
  }
  if(!fs.existsSync(baselinePath))throw Error('Baseline missing');
  const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
  if(baseline.schema!==1)throw Error('Unknown baseline schema');
  const check=verify(all,baseline);
  if(check.violations.length){
    for(const v of check.violations)console.error(v);
    throw Error(check.violations.length+' comment ratchet violations; baseline unchanged');
  }
  if(mode==='shrink'){
    baseline.files=check.next;
    fs.writeFileSync(baselinePath,JSON.stringify(baseline,null,2)+'\n');
  }
  console.log('PASS '+mode+' '+JSON.stringify(stats));
}
export { collect, evaluate, verify, tsComments, lexicalComments };
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.error(e.stack||String(e));process.exitCode=1;});
}
