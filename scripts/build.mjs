import {cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename, dirname, extname, join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 20);
const RELEASE_PLACEHOLDER = '__MOONWOLF_RELEASE_ID__';

// GitHub Pages replaces the deployment directory. If cached HTML names an asset
// from the previous deployment, reload the document once rather than mixing old
// and new module versions. The query guard also works when storage is disabled.
function assetRecovery() {
  return `<script>(function(){
  var navigating=false;
  window.moonwolfAssetFailed=function(){
    if(navigating)return;
    var url=new URL(location.href);
    if(url.searchParams.get('__moonwolf_asset_retry')!=='${RELEASE_PLACEHOLDER}'){
      navigating=true;
      url.searchParams.set('__moonwolf_asset_retry','${RELEASE_PLACEHOLDER}');
      url.searchParams.set('__moonwolf_refresh',String(Date.now()));
      location.replace(url.href);
      return;
    }
    var show=function(){
      if(document.getElementById('asset-load-error'))return;
      var message=document.createElement('p');
      message.id='asset-load-error';
      message.setAttribute('role','alert');
      message.textContent='网页文件加载失败。请稍后刷新页面；房间与对局记录仍由服务器保存。';
      message.style.cssText='margin:16px;padding:12px;border:1px solid #efcf80;background:#fff7dc;color:#664c00';
      document.body.prepend(message);
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});else show();
  };
})();</script>`;
}

export function apiConfig(apiBase) {
  const value = String(apiBase ?? '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('API_BASE_URL must be an HTTPS origin'); }
  if (!/^https:\/\//i.test(value) || url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('API_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return `window.MOONWOLF_CONFIG = ${JSON.stringify({apiBase: url.origin})};\n`;
}

// Each deployed document names a complete immutable asset set. Bundling the
// module graph makes app.js, engine.js and problem-content.js one cache unit.
// Plain source paths remain available so an older HTML document can still load.
export async function buildStatic({sourceDir=join(projectRoot, 'web'), outputDir=join(projectRoot, 'dist'), apiBase=process.env.API_BASE_URL}={}) {
  sourceDir = resolve(sourceDir);
  outputDir = resolve(outputDir);
  if (sourceDir === outputDir || sourceDir.startsWith(outputDir + sep) || outputDir.startsWith(sourceDir + sep)) {
    throw new Error('Static source and output directories must not overlap');
  }
  const config = apiConfig(apiBase);
  let html = await readFile(join(sourceDir, 'index.html'), 'utf8');
  await rm(outputDir, {recursive:true, force:true});
  await mkdir(outputDir, {recursive:true});
  await cp(sourceDir, outputDir, {recursive:true});
  if (config !== null) await writeFile(join(outputDir, 'config.js'), config);

  const assets = {};
  const localRefs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["'](\.\/[^"']+)["'][^>]*>/gi)]
    .map(match => match[1]);
  for (const reference of [...new Set(localRefs)].sort()) {
    const name = reference.slice(2);
    if (/[?#]/.test(name)) throw new Error('Source asset references must not contain query strings or fragments: ' + reference);
    const file = resolve(outputDir, name);
    if (!file.startsWith(outputDir + sep)) throw new Error('Asset must be inside the static directory: ' + reference);
    let bytes;
    if (extname(name) === '.js') {
      const result = await build({entryPoints:[file], bundle:true, write:false, format:'esm',
        platform:'browser', target:'es2022', charset:'utf8', legalComments:'none', logLevel:'silent'});
      bytes = result.outputFiles[0].contents;
    } else {
      bytes = await readFile(file);
    }
    const extension = extname(name);
    const hashedName = join(dirname(name), basename(name, extension) + '-' + digest(bytes) + extension).split(sep).join('/');
    await writeFile(join(outputDir, hashedName), bytes);
    assets[name] = hashedName;
    html = html.replaceAll(`"${reference}"`, `"./${hashedName}"`).replaceAll(`'${reference}'`, `'./${hashedName}'`);
  }
  const hashedRefs = new Set(Object.values(assets).map(name=>'./'+name));
  html = html.replace(/<(?:script|link)\b[^>]*>/gi, tag => {
    const reference = tag.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    return hashedRefs.has(reference) ? tag.replace(/\s*\/?>$/, ' onerror="window.moonwolfAssetFailed()">') : tag;
  });
  html = html.replace(/(?=<(?:link|script)\b)/i, assetRecovery() + '\n  ');
  const meta = `<meta name="moonwolf-release" content="${RELEASE_PLACEHOLDER}">`;
  if (/<meta\b[^>]*\bname=["']moonwolf-release["'][^>]*>/i.test(html)) {
    html = html.replace(/<meta\b[^>]*\bname=["']moonwolf-release["'][^>]*>/i, meta);
  } else {
    html = html.replace('</head>', `  ${meta}\n</head>`);
  }
  // Hash the recovery template and placeholder metadata too, so changing the
  // early loader is a new release while identical inputs stay deterministic.
  const id = digest(html + '\n' + JSON.stringify(assets));
  html = html.replaceAll(RELEASE_PLACEHOLDER, id);
  await writeFile(join(outputDir, 'index.html'), html);
  await writeFile(join(outputDir, 'release.json'), JSON.stringify({id, assets}, null, 2) + '\n');
  return {id, assets};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const release = await buildStatic();
  console.log(`Built static website in dist/ (release ${release.id})`);
}
