import {lstat, realpath, readdir, mkdir, copyFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, dirname, relative, isAbsolute, extname, basename, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const source = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const [requested, ...extra] = process.argv.slice(2);
if (!requested || extra.length || !isAbsolute(requested)) {
  throw new Error('Usage: node scripts/export-github.mjs /absolute/new-empty-directory');
}

// Resolve existing ancestors as well, so a symlinked parent cannot place the
// destination inside the source tree. This script never removes any file.
async function canonicalDestination(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), basename(path));
  }
}
const destination = await canonicalDestination(resolve(requested));
const insideSource = relative(source, destination);
if (!insideSource || (!insideSource.startsWith('..' + sep) && insideSource !== '..' && !isAbsolute(insideSource))) {
  throw new Error('Choose a destination outside the source project.');
}
try {
  const target = await lstat(resolve(requested));
  if (target.isSymbolicLink() || !target.isDirectory()) throw new Error('Destination must be a regular directory, not a symlink or file.');
  if ((await readdir(destination)).length) throw new Error('Destination must be empty; existing contents will not be overwritten.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const directories = ['web', 'worker', 'server', 'scripts', 'tests', 'db', 'drizzle', '.github', 'docs'];
const rootFiles = [
  'package.json', 'package-lock.json', 'README.md', 'LICENSE',
  'Dockerfile', 'render.yaml', 'drizzle.config.ts', '.gitignore', '.env.example',
  'wrangler.example.json', 'wrangler.example.jsonc', 'wrangler.jsonc.example',
];
const excluded = new Set(['.git', '.openai', 'node_modules', 'dist', 'coverage', '.wrangler', '.DS_Store']);
const extensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html', '.svg', '.json', '.jsonc', '.yml', '.yaml', '.md', '.sql', '.txt', '.sh', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2']);
const files = [];

async function collect(path, optional = false) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink()) throw new Error('Source symlinks are not exported: ' + relative(source, path));
  const name = basename(path);
  if (excluded.has(name) || (name.startsWith('.env') && name !== '.env.example') || /\.(?:zip|tar|gz|log|pem|key|p12)$/i.test(name)) return;
  if (info.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) await collect(join(path, entry));
  } else if (info.isFile() && (rootFiles.includes(relative(source, path)) || extensions.has(extname(path)))) {
    files.push(relative(source, path));
  }
}
for (const path of [...rootFiles, ...directories]) await collect(join(source, path), true);
if (!files.includes('web/index.html') || !files.includes('.github/workflows/pages.yml')) {
  throw new Error('Required webpage or GitHub Pages workflow is missing.');
}
await mkdir(destination, {recursive:true});
// COPYFILE_EXCL also prevents a concurrent export or another process from
// replacing an existing destination file between validation and copying.
for (const file of files.sort()) {
  const target = join(destination, file);
  await mkdir(dirname(target), {recursive:true});
  await copyFile(join(source, file), target, constants.COPYFILE_EXCL);
}
console.log(JSON.stringify({directory:destination, fileCount:files.length, files}, null, 2));
