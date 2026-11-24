import assert from 'node:assert/strict';

// An optional platform service token is accepted through hidden stdin only.
// It is never saved, printed, or embedded in frontend assets.
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdout.write('Ready for verification JSON on stdin (input is hidden).\n');
let buffer='';
const config=await new Promise((resolve,reject)=>{
  process.stdin.on('data',chunk=>{
    buffer+=chunk.toString();
    if(buffer.includes('\n')){process.stdin.pause();try{resolve(JSON.parse(buffer.trim()));}catch(error){reject(error);}}
  });
});
const origin=new URL(config.origin).origin;
const reports=[];
async function call(path,{method='GET',body,token}={}){
  const response=await fetch(origin+path,{method,headers:{
    ...(config.siteToken?{'OAI-Sites-Authorization':'Bearer '+config.siteToken}:{}),
    ...(token?{Authorization:'Bearer '+token}:{}),
    ...(body?{'Content-Type':'application/json'}:{})
  },body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});
  const data=await response.json().catch(()=>({error:'Non-JSON response'}));
  assert.equal(response.ok,true,`${path}: HTTP ${response.status} ${data.error||''}`);
  return data;
}
const health=await call('/api/health');
assert.equal(health.service,'moonwolf');assert.ok(['d1','postgres'].includes(health.storage),'Persistent storage must be D1 or Postgres');
reports.push(`production API and ${health.storage} storage available`);
const stamp=Date.now().toString(36).slice(-4);
const clients=await Promise.all(Array.from({length:12},(_,i)=>call('/api/session',{method:'POST',body:{name:`验收${stamp}-${i+1}`}})));
const matches=await Promise.all(clients.map(c=>call('/api/match',{method:'POST',body:{},token:c.token})));
const codes=new Set(matches.map(m=>m.room.code));assert.equal(codes.size,1);
const views=await Promise.all(clients.map(c=>call('/api/room',{token:c.token})));
assert.ok(views.every(v=>v.room.game&&v.room.players.length===12));
assert.equal(new Set(views[0].room.players.map(p=>p.seat)).size,12);
for(let i=0;i<clients.length;i++){
  const game=views[i].room.game;
  for(const p of game.players)if(p.id!==clients[i].player.id&&!(game.myRole==='wolf'&&p.role==='wolf'))assert.equal(p.role,undefined);
  assert.equal(game.audit,undefined);assert.equal(game.actions,undefined);
}
reports.push('12 separate sessions joined one room concurrently and started automatically');
reports.push('hidden roles and night actions are filtered per player');
const restored=await call('/api/session',{method:'POST',body:{},token:clients[0].token});
assert.equal(restored.player.id,clients[0].player.id);
assert.equal((await call('/api/room',{token:restored.token})).room.code,[...codes][0]);
reports.push('reconnected session retains the same seat');
const extras=await Promise.all([13,14].map(i=>call('/api/session',{method:'POST',body:{name:`验收${stamp}-${i}`}})));
const created=await call('/api/rooms',{method:'POST',body:{name:'联机功能验收',visibility:'private',config:{roles:{wolf:2,villager:2,seer:1,witch:1,hunter:0,guard:0},victory:'side',nightSeconds:60,otherNightSeconds:30,daySeconds:60}},token:extras[0].token});
assert.match(created.room.code,/^\d{6}$/);
const joined=await call('/api/join',{method:'POST',body:{code:created.room.code},token:extras[1].token});
assert.equal(joined.room.players.length,2);
assert.equal((await call('/api/rooms',{token:extras[1].token})).rooms.some(r=>r.code===created.room.code),false);
const message='跨设备联机验收';
await call('/api/chat',{method:'POST',body:{text:message,channel:'public'},token:extras[0].token});
assert.ok((await call('/api/room',{token:extras[1].token})).room.messages.some(m=>m.text===message));
await call('/api/leave',{method:'POST',body:{},token:extras[1].token});
await call('/api/leave',{method:'POST',body:{},token:extras[0].token});
reports.push('custom six-player configuration, six-digit invitation, private visibility and cross-session chat work');
console.log(JSON.stringify({ok:true,checks:reports,matchCode:[...codes][0],note:'The started QA room expires automatically after inactivity.'}));
process.exit(0);
