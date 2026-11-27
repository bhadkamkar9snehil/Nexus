import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { publishFile, visualProject } from './visual-assets.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=(value:unknown)=>{
  if(typeof value!=='string'||!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value)||value.includes('..'))throw new Error('Versioned workflow identifier required');
  return value;
};
const description=(v:unknown)=>{if(typeof v!=='string'||!v.trim()||v.length>2000)throw new Error('Invalid workflow description');return v;};
const sha=(v:unknown)=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('Invalid reference hash');return v;};
const threshold=(v:unknown)=>{const t=v??0.8;if(typeof t!=='number'||!Number.isFinite(t)||t<=0.5||t>1)throw new Error('Invalid workflow threshold');return t;};
export type Contract={id:string;project:string;checks:string[];reference_hashes:string[];threshold:number};
export type Recipe={id:string;project:string;states:Record<string,string>;transitions:{from:string;to:string;action_id:string;postcondition:string}[];threshold:number};
type Definition=Contract|Recipe;
const folder=(root:string,project:string,kind:string)=>join(root,'secrets','visual-workflows',visualProject(project),kind);
export function contractDefinition(args:Record<string,any>):Contract{
  if(!Array.isArray(args.checks)||args.checks.length<1||args.checks.length>12)throw new Error('Supply 1-12 assertions');
  const refs=args.reference_hashes??[];
  if(!Array.isArray(refs)||refs.length>3)throw new Error('Maximum three reference hashes');
  return {id:id(args.id),project:visualProject(args.project),checks:args.checks.map(description),reference_hashes:refs.map(sha),threshold:threshold(args.threshold)};
}
export function recipeDefinition(args:Record<string,any>):Recipe{
  if(!args.states||typeof args.states!=='object'||Array.isArray(args.states)||Object.keys(args.states).length<2||Object.keys(args.states).length>12)throw new Error('Supply 2-12 recipe states');
  const states=Object.fromEntries(Object.entries(args.states).map(([key,value])=>[id(key),description(value)]));
  if(!Array.isArray(args.transitions)||args.transitions.length<1||args.transitions.length>50)throw new Error('Supply 1-50 transitions');
  const transitions=args.transitions.map((v:any)=>{
    const from=id(v?.from),to=id(v?.to),action_id=id(v?.action_id),postcondition=description(v?.postcondition);
    if(!Object.hasOwn(states,from)||!Object.hasOwn(states,to))throw new Error('Unknown recipe state');
    return {from,to,action_id,postcondition};
  });
  if(new Set(transitions.map((v:any)=>v.from)).size!==transitions.length)throw new Error('Ambiguous next action; one transition per state');
  return {id:id(args.id),project:visualProject(args.project),states,transitions,threshold:threshold(args.threshold)};
}
export async function defineWorkflow(root:string,kind:'contracts'|'recipes',definition:Definition){
  const dir=folder(root,definition.project,kind);await mkdir(dir,{recursive:true});
  const path=join(dir,definition.id+'.json'),hash=digest(definition);
  const record={definition,hash,recorded_at:new Date().toISOString()};
  try{await publishFile(path,JSON.stringify(record));}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const prior=JSON.parse(await readFile(path,'utf8'));if(prior.hash!==hash)throw new Error('Immutable version already exists; use a new version');return prior;}
  return record;
}
export async function getWorkflow(root:string,kind:'contracts'|'recipes',project:string,key:unknown){
  const path=join(folder(root,project,kind),id(key)+'.json');
  const record=JSON.parse(await readFile(path,'utf8'));
  const definition=kind==='contracts'?contractDefinition(record.definition):recipeDefinition(record.definition);
  if(record.hash!==digest(definition)||definition.project!==project||definition.id!==key)throw new Error('Workflow integrity failure');
  return record;
}
export async function listWorkflows(root:string,kind:'contracts'|'recipes',project:string){
  const entries=await readdir(folder(root,project,kind)).catch(e=>{if(e.code==='ENOENT')return [] as string[];throw e;});
  const names=entries.filter(n=>n.endsWith('.json')).sort();
  const records=[];
  for(const name of names.slice(0,100))records.push(await getWorkflow(root,kind,project,name.slice(0,-5)));
  return {records,truncated:names.length>100};
}
export function nextTransition(recipe:Recipe,selected:unknown){
  if(typeof selected!=='string'||!Object.hasOwn(recipe.states,selected))return {state:null,next:null,executed:false};
  return {state:selected,next:recipe.transitions.find(v=>v.from===selected)??null,executed:false};
}
