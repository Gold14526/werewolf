import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../web/engine.js';

// A minimal DOM boundary lets us exercise the actual networking/session code
// without a browser dependency. Layout remains a browser acceptance check.
const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*?;\n/, '') + '\n;globalThis.frontend = {state,connect,refreshData,mutation,invitationUrl,joinRoom,waitForConnect:()=>connectPromise};';

async function loadFrontend(fetch, {token='',url='https://moonwolf.test/'}={}) {
  const saved = new Map(token ? [['moonwolf:token:',token]] : []);
  const local = new Map([['moonwolf:name','固定昵称']]);
  const element = () => ({innerHTML:'',textContent:'',classList:{add(){},remove(){},toggle(){}},focus(){}});
  const elements = new Map(['#app','#modal-root','#toast'].map(key=>[key,element()]));
  const callbacks = new Map();
  const context = vm.createContext({
    ...engine, URL, Response, AbortSignal, structuredClone, console,
    location:{href:url,protocol:'https:'}, history:{replaceState(){}},
    localStorage:{getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)},
    sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)},
    document:{activeElement:null,visibilityState:'visible',querySelector:key=>elements.get(key)||null,querySelectorAll:()=>[],getElementById:()=>null,addEventListener:(name,cb)=>callbacks.set(name,cb)},
    window:{MOONWOLF_CONFIG:{apiBase:''},addEventListener(){}}, navigator:{}, fetch,
    setTimeout:()=>0,clearTimeout(){},setInterval(){},
  });
  vm.runInContext(source,context,{filename:'app.js'});
  await context.frontend.waitForConnect();
  return {app:context.frontend,saved,local,elements};
}
const reply = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const baseResponse = path => path==='/api/health'?{ok:true,service:'moonwolf'}:path==='/api/room'?{room:null}:path==='/api/rooms'?{rooms:[]}:path==='/api/history'?{history:[]}:{standings:[]};

test('frontend restores the existing player without accidentally renaming during a game',async()=>{
  const calls=[];
  const {app,local}=await loadFrontend(async(path,options)=>{
    calls.push({path,...options});
    return reply(path==='/api/session'?{token:'retained-token',player:{id:'same-player',name:'服务器昵称'}}:baseResponse(path));
  },{token:'retained-token'});
  const session=calls.find(call=>call.path==='/api/session');
  assert.equal(session.headers.Authorization,'Bearer retained-token');
  assert.equal(session.body,'{}');
  assert.equal(app.state.player.id,'same-player');
  assert.equal(app.state.name,'服务器昵称');
  assert.equal(local.get('moonwolf:name'),'服务器昵称');
  assert.equal(app.state.online,true);
});

test('frontend replaces an expired bearer once and retains the fresh session',async()=>{
  const sessions=[];
  const {app,saved}=await loadFrontend(async(path,options)=>{
    if(path!=='/api/session')return reply(baseResponse(path));
    sessions.push(options);
    if(options.headers.Authorization)return reply({error:'会话过期'},401);
    return reply({token:'fresh-token',player:{id:'fresh-player',name:'固定昵称'}});
  },{token:'expired-token'});
  assert.equal(sessions.length,2);
  assert.equal(sessions[1].headers.Authorization,undefined);
  assert.equal(app.state.online,true);
  assert.equal(saved.get('moonwolf:token:'),'fresh-token');
});

test('an old polling response cannot overwrite a successful room mutation',async()=>{
  let holdNext=false,release;
  const room={code:'123456',name:'测试房间',config:engine.STANDARD_CONFIG,players:[{id:'p1',name:'玩家',seat:1,ready:false}],game:null,messages:[],hostId:'p1',visibility:'private'};
  const updated=structuredClone(room);updated.players[0].ready=true;
  const {app}=await loadFrontend(async(path)=>{
    if(path==='/api/session')return reply({token:'token',player:{id:'p1',name:'玩家'}});
    if(path==='/api/room'){
      if(holdNext){holdNext=false;return new Promise(resolve=>{release=()=>resolve(reply({room}));});}
      return reply({room});
    }
    if(path==='/api/ready')return reply({room:updated});
    return reply(baseResponse(path));
  });
  holdNext=true;
  const poll=app.refreshData();
  await app.mutation('/api/ready',{ready:true});
  release();await poll;
  assert.equal(app.state.room.players[0].ready,true);
});

test('offline connection can recover without creating parallel duplicate sessions',async()=>{
  let offline=true,sessionCount=0;
  const {app}=await loadFrontend(async(path)=>{
    if(offline)throw new TypeError('Network unavailable');
    if(path==='/api/session'){sessionCount++;return reply({token:'token',player:{id:'p1',name:'玩家'}});}
    return reply(baseResponse(path));
  });
  assert.equal(app.state.online,false);
  offline=false;
  await Promise.all([app.connect(),app.connect()]);
  assert.equal(app.state.online,true);
  assert.equal(sessionCount,1);
});

test('invitation URLs preserve GitHub repository paths and never embed credentials',async()=>{
  const {app,elements}=await loadFrontend(async(path)=>reply(path==='/api/session'?{token:'secret-token',player:{id:'p1',name:'玩家'}}:baseResponse(path)),{url:'https://example.github.io/moonwolf/?room=123456#lobby'});
  assert.equal(app.invitationUrl('654321'),'https://example.github.io/moonwolf/?room=654321');
  assert.match(elements.get('#modal-root').innerHTML,/value="123456"/);
  assert.equal(app.state.room,null,'opening an invitation must not silently join');
});
