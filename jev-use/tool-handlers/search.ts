import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findFiles, searchStatus } from '../find-files.js';
import { mapFiles, rootPlan } from '../file-map.js';
import { searchContent } from '../search-content.js';
import { searchLocal } from '../local-search.js';
import { readTextFile } from '../read-text-file.js';
import { readDocument } from '../read-document.js';
import { binaryTransfer } from '../binary-transfer.js';
import { writeTextFile, editTextFile } from '../write-text-file.js';
import type { ToolRegistry } from '../tool-registry.js';
import type { ToolInvocation } from '../tool-context.js';

export function registerSearchTools(registry: ToolRegistry<ToolInvocation>) {
  registry.bind('search_status', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = await searchStatus();
    return output;
  });
  registry.bind('find_files', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const drive = args.drive ?? 'C';
          const kind = args.kind ?? 'any';
          const count = args.limit ?? 20;
          if (typeof drive !== 'string' || !/^[A-Za-z]$/.test(drive)) throw new Error('drive must be one letter');
          if (kind !== 'any' && kind !== 'file' && kind !== 'folder') throw new Error('Invalid kind');
          if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) throw new Error('Invalid limit');
          output = await findFiles({ pattern: required('pattern'), drive, kind, limit: count, pathFilter: args.path_filter === undefined ? undefined : required('path_filter'), query: args.query === undefined ? undefined : required('query') }, addUsage);
    return output;
  });
  registry.bind('map_files', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    const action = args.action ?? 'build';
          if (action !== 'build' && action !== 'view' && action !== 'root_plan' && action !== 'serve') throw new Error('Invalid action');
          const roots = args.roots ?? [join(homedir(), 'Downloads'), join(homedir(), 'Documents')];
          if (!Array.isArray(roots) || roots.length > 5 || roots.some((r: unknown) => typeof r !== 'string' || !/^[A-Za-z]:\\/.test(r))) throw new Error('roots must be absolute Windows paths');
          const limitUnits = args.limit_units;
          if (limitUnits !== undefined && (typeof limitUnits !== 'number' || !Number.isInteger(limitUnits) || limitUnits < 1)) throw new Error('Invalid limit_units');
          const outDir = args.out_dir === undefined ? join(homedir(), 'tools', 'file-map') : required('out_dir');
          if (action === 'serve') { // saves from the pages go to disk with one click; page opens at http://127.0.0.1:8766
            const page = args.open === false ? '' : 'root_plan.html';
            spawn(process.execPath, [join(import.meta.dirname, '..', 'file-map-serve.mjs'), outDir, '8766'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); // a second copy exits on EADDRINUSE
            if (page) spawn('cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:8766/' + page], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
            output = JSON.stringify({ status: 'done', action: 'serve', url: 'http://127.0.0.1:8766/', pages: ['root_plan.html', 'review.html', 'treemap.html'], steps: 0 });
          } else output = action === 'root_plan'
            ? await rootPlan({ roots, outDir, limit: limitUnits, open: args.open === true }, addUsage)
            : await mapFiles({ action, roots, outDir, limitUnits, open: args.open === true }, addUsage);
    return output;
  });
  registry.bind('jev_search_content', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = await searchContent(required('root'), required('pattern'), required('query'), addUsage);
    return output;
  });
  registry.bind('search_local', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    if (args.regex !== undefined && typeof args.regex !== 'boolean') throw new Error('Invalid regex');
          output = JSON.stringify(await searchLocal({ root: required('root'), pattern: required('pattern'), glob: args.glob === undefined ? undefined : required('glob'), regex: args.regex as boolean | undefined, limit: args.limit as number | undefined }));
    return output;
  });
  registry.bind('nexus_read_file', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await readTextFile({ path: required('path'), offset: args.offset as number | undefined, length: args.length as number | undefined }));
    return output;
  });
  registry.bind('nexus_read_document', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await readDocument({ path: required('path'), offset: args.offset as number | undefined, length: args.length as number | undefined, sheet: args.sheet === undefined ? undefined : required('sheet') }));
    return output;
  });
  registry.bind('nexus_write_file', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await writeTextFile({ path: required('path'), content: args.content as string, overwrite: args.overwrite as boolean | undefined, expected_sha256: args.expected_sha256 as string | undefined }));
    return output;
  });
  registry.bind('nexus_upload_file',async ({args,required})=>{const f=args.file;if(!f||typeof f.id!=='string'||!f.id.length||f.id.length>128||typeof f.mimeType!=='string'||!f.mimeType||f.digest?.algorithm!=='sha-256'||typeof f.digest?.value!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(f.digest.value))throw new Error('Invalid file metadata or digest');const digest=Buffer.from(f.digest.value,'base64url');if(digest.length!==32||digest.toString('base64url')!==f.digest.value)throw new Error('Invalid digest');return JSON.stringify(await binaryTransfer({action:'upload',path:required('path'),data:f.data===undefined&&f.size===0?'':f.data,size:f.size,sha256:digest.toString('hex')}));});
  registry.bind('nexus_transfer_file', async ({args,required}) => JSON.stringify(await binaryTransfer({action:required('action'),path:required('path'),data:args.data as string|undefined,size:args.size as number|undefined,sha256:args.sha256 as string|undefined})));
  registry.bind('nexus_edit_file', async ({ name, args, required, limit, goal, addUsage, root, browserTask, desktopTask }) => {
    let output: string;
    output = JSON.stringify(await editTextFile({ path: required('path'), old_text: args.old_text as string, new_text: args.new_text as string, expected_replacements: args.expected_replacements as number | undefined }));
    return output;
  });
}
