import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createApp} from '../server/index.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('online SQLite backup restores acknowledged room and identity and refuses overwrite',async()=>{
  const tempRoot=await stat(tmpdir()).then(()=>tmpdir(),error=>{if(error.code==='ENOENT')return root;throw error;});
  const dir=await mkdtemp(join(tempRoot,'moonwolf-backup-'));
  const source=join(dir,'live.sqlite'),backup=join(dir,'backups','snapshot.sqlite');
  let original,restored;
  try{
    original=createApp({databasePath:source,disableRateLimits:true});
    await new Promise(resolve=>original.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${original.server.address().port}`;
    const sessionResponse=await fetch(origin+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'备份玩家'})});
    assert.equal(sessionResponse.status,201);
    const session=await sessionResponse.json();
    const roomResponse=await fetch(origin+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.token}`},body:JSON.stringify({name:'恢复房间'})});
    assert.equal(roomResponse.status,200);
    const {room}=await roomResponse.json();
    const run=()=>spawnSync(process.execPath,[join(root,'scripts/backup.mjs'),backup],{env:{...process.env,DATABASE_PATH:source},encoding:'utf8'});
    const created=run();
    assert.equal(created.status,0,created.stderr);
    const saved=await readFile(backup);
    const again=run();
    assert.notEqual(again.status,0);
    assert.deepEqual(await readFile(backup),saved,'existing backup must remain intact');
    restored=createApp({databasePath:backup,disableRateLimits:true});
    await new Promise(resolve=>restored.listen(0,'127.0.0.1',resolve));
    const response=await fetch(`http://127.0.0.1:${restored.server.address().port}/api/room`,{headers:{Authorization:`Bearer ${session.token}`}});
    assert.equal(response.status,200);
    const data=await response.json();
    assert.equal(data.room.code,room.code);
    assert.equal(data.room.players[0].id,session.player.id);
    assert.equal(data.room.players[0].name,'备份玩家');
  }finally{
    await restored?.close();
    await original?.close();
    await rm(dir,{recursive:true,force:true});
  }
});
