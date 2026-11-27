import { build } from '../jev-use/node_modules/esbuild/lib/main.js';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = join(import.meta.dirname, '..');
const modules = join(root, 'jev-use/node_modules');
const out = join(root, 'monitor-ui/dist');
mkdirSync(out, { recursive: true });
await build({ entryPoints: [join(import.meta.dirname, 'app.tsx')], outfile: join(out, 'app.js'), bundle: true, minify: true,
  jsx: 'automatic', nodePaths: [modules], alias: { '@/lib/utils': join(import.meta.dirname, 'utils.ts') },
  define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'external' });
const css = readFileSync(join(import.meta.dirname, 'upstream/globals.css'), 'utf8')
  .replace('@import "tailwindcss";', '@import "../jev-use/node_modules/tailwindcss";\n@source "./app.tsx";\n@source "./views.tsx";\n@source "./observability.tsx";\n@source "./tasks.tsx";\n@source "./inbox.tsx";\n@source "./rich-message.tsx";\n@source "./devices.tsx";\n@source "./settings.tsx";\n@source "./updates.tsx";\n@source "./peers.tsx";\n@source "./widgets.tsx";\n@source "./data.ts";\n@source "./upstream/viz.tsx";\n@source "./upstream/button.tsx";');
writeFileSync(join(import.meta.dirname, '.build.css'), css + '\n@font-face{font-family:Geist;src:url(/assets/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}\n@font-face{font-family:GeistMono;src:url(/assets/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}\n:root{--font-geist-sans:Geist;--font-geist-mono:GeistMono}\n');
const result = spawnSync(process.execPath, [join(modules, '@tailwindcss/cli/dist/index.mjs'), '-i', join(import.meta.dirname, '.build.css'), '-o', join(out, 'app.css'), '--minify'], { stdio: 'inherit', cwd: root });
if (result.status !== 0) throw new Error('CSS build failed');
for (const pkg of ['geist','geist-mono']) {
  copyFileSync(join(modules, '@fontsource-variable', pkg, 'files', pkg + '-latin-wght-normal.woff2'), join(out, pkg + '.woff2'));
  copyFileSync(join(modules, '@fontsource-variable', pkg, 'LICENSE'), join(out, pkg + '-LICENSE.txt'));
}
console.log('Monitor production assets built.');
