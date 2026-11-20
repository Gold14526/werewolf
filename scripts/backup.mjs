import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, openSync, closeSync, unlinkSync, realpathSync, statSync, fsyncSync} from 'node:fs';
import {resolve, dirname, relative, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const [requested,...extra]=process.argv.slice(2);
if(!requested||extra.length)throw new Error('Usage: npm run backup -- /absolute/path/to/new-backup.sqlite');
if(!isAbsolute(requested))throw new Error('Choose an absolute backup path outside the public web directory.');
const source=realpathSync(resolve(process.env.DATABASE_PATH||resolve(root,'data/moonwolf.sqlite')));
if(!statSync(source).isFile())throw new Error('DATABASE_PATH must be an existing SQLite database file.');
const destination=resolve(requested);
if(destination===source)throw new Error('The backup destination must differ from DATABASE_PATH.');
process.umask(0o077);
mkdirSync(dirname(destination),{recursive:true,mode:0o700});
const publicDir=realpathSync(resolve(root,'web'));
const relativeParent=relative(publicDir,realpathSync(dirname(destination)));
if(relativeParent!=='..'&&!relativeParent.startsWith('..'+sep)&&!isAbsolute(relativeParent))throw new Error('Never place database backups in the public web directory.');
const db=new DatabaseSync(source,{readOnly:true});
let reserved=false;
try{
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
  const integrity=db.prepare('PRAGMA quick_check').get();
  if(Object.values(integrity)[0]!=='ok')throw new Error('Source database integrity check failed.');
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_state'").get())throw new Error('Source is not a Moonwolf state database.');
  // Reserve an empty file exclusively. SQLite permits VACUUM INTO an empty file;
  // an existing backup is never silently replaced.
  closeSync(openSync(destination,'wx',0o600));
  reserved=true;
  db.prepare('VACUUM INTO ?').run(destination);
  const backup=new DatabaseSync(destination,{readOnly:true});
  try{
    if(Object.values(backup.prepare('PRAGMA quick_check').get())[0]!=='ok')throw new Error('Backup integrity check failed.');
  }finally{backup.close();}
  const descriptor=openSync(destination,'r');
  try{fsyncSync(descriptor);}finally{closeSync(descriptor);}
  if(process.platform!=='win32'){
    const directory=openSync(dirname(destination),'r');
    try{fsyncSync(directory);}finally{closeSync(directory);}
  }
  console.log(`Created consistent SQLite backup: ${destination}`);
}catch(error){
  if(reserved)unlinkSync(destination);
  throw error;
}finally{db.close();}
