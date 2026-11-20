import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOURCE_NAME = /^[a-z][a-z0-9-]{1,61}[a-z0-9]$/;

function name(value,fallback,label){
  const result=String(value||fallback).trim();
  if(!RESOURCE_NAME.test(result))throw new Error(`${label} must contain 3–63 lowercase letters, numbers or hyphens, begin with a letter and end with a letter or number`);
  return result;
}

function origin(value){
  let url;
  try{url=new URL(value);}catch{throw new Error('ALLOWED_ORIGINS must contain valid HTTPS origins');}
  if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('ALLOWED_ORIGINS must contain HTTPS origins only, without credentials, paths, queries or fragments');
  return url.origin;
}

/** Only non-secret deployment configuration belongs in the generated file. */
export function makeCloudflareConfig(env){
  const databaseId=String(env.CF_DATABASE_ID||'').trim();
  if(!UUID.test(databaseId))throw new Error('CF_DATABASE_ID must be the UUID of your existing Cloudflare D1 database');
  const origins=new Set();
  const owner=String(env.GITHUB_REPOSITORY_OWNER||'').trim();
  if(owner){
    if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner))throw new Error('GITHUB_REPOSITORY_OWNER is invalid');
    origins.add(origin(`https://${owner}.github.io`));
  }
  for(const value of String(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean))origins.add(origin(value));
  return {
    $schema:'node_modules/wrangler/config-schema.json',
    name:name(env.WORKER_NAME,'werewolf-api','WORKER_NAME'),
    main:'dist/server/index.js',
    compatibility_date:'2026-11-20',
    workers_dev:true,
    vars:{ALLOWED_ORIGINS:[...origins].join(',')},
    d1_databases:[{
      binding:'DB',
      database_name:name(env.CF_DATABASE_NAME,'werewolf-db','CF_DATABASE_NAME'),
      database_id:databaseId,
      migrations_dir:'drizzle',
    }],
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const config=makeCloudflareConfig(process.env);
  await writeFile('wrangler.generated.json',JSON.stringify(config,null,2)+'\n');
  console.log(`Prepared Cloudflare configuration for ${config.name}; no credentials were written.`);
}
