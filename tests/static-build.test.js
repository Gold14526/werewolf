import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import vm from 'node:vm';
import {apiConfig, buildStatic} from '../scripts/build.mjs';

async function fixture(t) {
  const directory=await mkdtemp(new URL('./.static-build-', import.meta.url));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const sourceDir=join(directory,'source'),outputDir=join(directory,'output');
  await mkdir(join(sourceDir,'assets'),{recursive:true});
  const files={
    'index.html':'<!doctype html><html><head><link rel="icon" href="./assets/favicon.ico"><link rel="stylesheet" href="./style.css"><script src="./config.js"></script><script type="module" src="./app.js"></script><script type="module" src="./release.js"></script></head><body>Test</body></html>',
    'config.js':'window.MOONWOLF_CONFIG = {apiBase:""};\n',
    'app.js':'import { value } from "./engine.js"; import { title } from "./problem-content.js"; window.example = value + title;\n',
    'engine.js':'export const value = 1;\n',
    'problem-content.js':'export const title = "狼人";\n',
    'release.js':'window.releaseCheckLoaded = true;\n',
    'style.css':'body {color: #333}\n',
    'assets/favicon.ico':Buffer.from([0,0,1,0,1,0,32,32]),
  };
  await Promise.all(Object.entries(files).map(([name,contents])=>writeFile(join(sourceDir,name),contents)));
  return {sourceDir,outputDir};
}

test('static release references hashed complete assets and keeps legacy paths usable',async t=>{
  const paths=await fixture(t);
  const release=await buildStatic({...paths,apiBase:'https://api.example.com/'});
  const html=await readFile(join(paths.outputDir,'index.html'),'utf8');
  assert.match(html,new RegExp(`<meta name="moonwolf-release" content="${release.id}">`));
  for (const [name,hashed] of Object.entries(release.assets)) {
    assert.match(hashed,/-[0-9a-f]{20}\.(?:js|css|ico)$/);
    assert.ok(html.includes(`./${hashed}`));
    assert.ok((await readFile(join(paths.outputDir,hashed))).length);
    assert.ok((await readFile(join(paths.outputDir,name))).length,'old cached HTML asset path remains present');
  }
  const app=await readFile(join(paths.outputDir,release.assets['app.js']),'utf8');
  assert.doesNotMatch(app,/\bimport\s/,'engine and statement cannot come from an older independent module cache');
  assert.match(app,/狼人/);
  const config=await readFile(join(paths.outputDir,release.assets['config.js']),'utf8');
  assert.match(config,/https:\/\/api\.example\.com/);
  assert.deepEqual(JSON.parse(await readFile(join(paths.outputDir,'release.json'),'utf8')),release);
});

test('identical inputs keep the release stable and nested module or API changes invalidate it',async t=>{
  const paths=await fixture(t);
  const first=await buildStatic({...paths,apiBase:'https://api.example.com'});
  const again=await buildStatic({...paths,apiBase:'https://api.example.com'});
  assert.deepEqual(again,first);
  await writeFile(join(paths.sourceDir,'engine.js'),'export const value = 2;\n');
  const changed=await buildStatic({...paths,apiBase:'https://api.example.com'});
  assert.notEqual(changed.id,first.id);
  assert.notEqual(changed.assets['app.js'],first.assets['app.js']);
  assert.equal(changed.assets['style.css'],first.assets['style.css']);
  const moved=await buildStatic({...paths,apiBase:'https://other.example.com'});
  assert.notEqual(moved.id,changed.id);
  assert.notEqual(moved.assets['config.js'],changed.assets['config.js']);
});

test('static build accepts only explicit HTTPS API origins and preserves local default config',async t=>{
  for (const value of ['http://api.example.com','https:api.example.com','https://u:p@api.example.com','https://api.example.com/path','https://api.example.com/?x=1','https://api.example.com/#secret']) {
    assert.throws(()=>apiConfig(value),/API_BASE_URL/);
  }
  assert.equal(apiConfig(''),null);
  const paths=await fixture(t);
  await buildStatic({...paths,apiBase:''});
  assert.equal(await readFile(join(paths.outputDir,'config.js'),'utf8'),await readFile(join(paths.sourceDir,'config.js'),'utf8'));
});


test('missing versioned assets reload fresh HTML only once and preserve the room invitation',async t=>{
  const paths=await fixture(t);
  const release=await buildStatic({...paths,apiBase:''});
  const html=await readFile(join(paths.outputDir,'index.html'),'utf8');
  const recovery=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.equal((html.match(/onerror="window.moonwolfAssetFailed\(\)"/g)||[]).length,Object.keys(release.assets).length);
  const navigations=[],messages=[];
  const location={href:'https://example.github.io/werewolf/?room=123456#room',replace:url=>navigations.push(url)};
  const document={readyState:'complete',getElementById:id=>messages.find(item=>item.id===id),
    createElement:()=>({setAttribute(){},style:{}}),body:{prepend:element=>messages.push(element)}};
  const context=vm.createContext({window:{},document,location,URL,Date});
  vm.runInContext(recovery,context);
  context.window.moonwolfAssetFailed();
  context.window.moonwolfAssetFailed();
  assert.equal(navigations.length,1,'simultaneous resource failures must not trigger multiple navigations');
  const target=new URL(navigations[0]);
  assert.equal(target.pathname,'/werewolf/');
  assert.equal(target.searchParams.get('room'),'123456');
  assert.equal(target.hash,'#room');
  assert.equal(target.searchParams.get('__moonwolf_asset_retry'),release.id);
  const retried=vm.createContext({window:{},document,location:{...location,href:target.href},URL,Date});
  vm.runInContext(recovery,retried);
  retried.window.moonwolfAssetFailed();
  retried.window.moonwolfAssetFailed();
  assert.equal(navigations.length,1,'the same failed release must stop rather than reload forever');
  assert.equal(messages.length,1);
  assert.match(messages[0].textContent,/网页文件加载失败/);
});
