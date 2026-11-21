import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist-neon/', import.meta.url);
await mkdir(output, { recursive: true });

// pg has CommonJS dependencies that need Node's require inside an ESM bundle.
// Environment variables stay runtime lookups; no database URL is embedded.
await build({
  absWorkingDir: root,
  entryPoints: ['neon/index.mjs'],
  outfile: fileURLToPath(new URL('index.mjs', output)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: [
    "import { createRequire as __moonwolfCreateRequire } from 'node:module';",
    "import { fileURLToPath as __moonwolfFileURLToPath } from 'node:url';",
    "import { dirname as __moonwolfDirname } from 'node:path';",
    'const require = __moonwolfCreateRequire(import.meta.url);',
    'const __filename = __moonwolfFileURLToPath(import.meta.url);',
    'const __dirname = __moonwolfDirname(__filename);',
  ].join('\n') },
});

const bundle = await readFile(new URL('index.mjs', output));
// Only the function entry enters the archive. Source, env files and build
// leftovers can never be accidentally included in an upload.
const archive = zipSync({
  'index.mjs': [bundle, { mtime: new Date('2020-01-01T00:00:00Z') }],
}, { level: 9 });
await writeFile(new URL('werewolf.zip', output), archive);
console.log(`Built dist-neon/index.mjs (${bundle.byteLength} bytes) and dist-neon/werewolf.zip (${archive.byteLength} bytes)`);
