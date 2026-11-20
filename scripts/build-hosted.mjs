import {readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {resolve,dirname,relative,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,'dist');
const portable=process.argv.includes('--portable');
const modules=new Map();
const chunks=[];

// These owned modules intentionally use only relative named imports/exports.
// Fail on unsupported syntax instead of producing an incomplete bundle.
function bundle(filename){
  const file=resolve(filename);
  if(modules.has(file))return modules.get(file);
  if(!file.startsWith(root+'/'))throw new Error('Bundled modules must be in this project');
  const symbol='__module'+modules.size;
  modules.set(file,symbol);
  let source=readFileSync(file,'utf8');
  source=source.replace(/^\s*import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*$/gm,(_,names,request)=>{
    if(!request.startsWith('.'))throw new Error('Runtime dependencies are not supported: '+request);
    const dependency=bundle(resolve(dirname(file),request));
    return `const {${names.replace(/\s+as\s+/g,':')}} = ${dependency};\n`;
  });
  const exports=[];
  source=source.replace(/^export\s+((?:async\s+)?function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm,(_,type,name)=>{
    exports.push(name);return `${type} ${name}`;
  });
  if(/^\s*(?:import|export)\s/m.test(source))throw new Error('Unsupported module syntax in '+relative(root,file));
  chunks.push(`const ${symbol} = (()=>{\n${source}\nreturn {${exports.join(',')}};\n})();\n`);
  return symbol;
}

const api=bundle(resolve(root,'worker/api.js'));
const assets={};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
function gather(dir){for(const file of readdirSync(dir,{withFileTypes:true})){
  const path=resolve(dir,file.name);
  if(file.isDirectory())gather(path);
  else if(mime[extname(path)])assets['/'+relative(resolve(root,'web'),path).split('\\').join('/')]=[mime[extname(path)],readFileSync(path,'utf8')];
}}
gather(resolve(root,'web'));
const entry=`${chunks.join('\n')}
const __assets=${JSON.stringify(assets)};
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/'))return ${api}.handleApi(request,env);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    const asset=__assets[url.pathname==='/'?'/index.html':url.pathname];
    if(!asset)return new Response('Not found',{status:404});
    return new Response(request.method==='HEAD'?null:asset[1],{headers:{
      'Content-Type':asset[0],'Cache-Control':'no-cache',
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'self' https://chatgpt.com"
    }});
  }
};
`;
rmSync(output,{recursive:true,force:true});
mkdirSync(resolve(output,'server'),{recursive:true});
writeFileSync(resolve(output,'server/index.js'),entry);
if(!portable){
  mkdirSync(resolve(output,'.openai'),{recursive:true});
  writeFileSync(resolve(output,'.openai/hosting.json'),readFileSync(resolve(root,'.openai/hosting.json')));
}
const compiled=await import(pathToFileURL(resolve(output,'server/index.js')).href+'?build='+Date.now());
if(typeof compiled.default?.fetch!=='function')throw new Error('Worker fetch export missing');
const check=await compiled.default.fetch(new Request('https://test.invalid/'),{});
if(check.status!==200||!(await check.text()).includes('狼人杀'))throw new Error('Static asset check failed');
console.log(`Hosted Worker ready: ${modules.size} modules, ${Object.keys(assets).length} assets, ${Buffer.byteLength(entry)} bytes`);
