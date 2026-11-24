import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../web/engine.js';
import * as problem from '../web/problem-content.js';

// A minimal DOM boundary lets us exercise the actual networking/session code
// without a browser dependency. Layout remains a browser acceptance check.
const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*?;\n/gm, '') + '\n;globalThis.frontend = {state,connect,refreshData,mutation,invitationUrl,joinRoom,waitForConnect:()=>connectPromise};';

async function loadFrontend(fetch, {token='',url='https://moonwolf.test/',configuredApi='',storedApi,abortSignal=AbortSignal}={}) {
  const saved = new Map(token ? [['moonwolf:token:',token]] : []);
  const local = new Map([['moonwolf:name','固定昵称']]);
  if(storedApi!==undefined)local.set('moonwolf:apiBase',storedApi);
  const element = () => ({innerHTML:'',textContent:'',classList:{add(){},remove(){},toggle(){}},focus(){}});
  const elements = new Map(['#app','#modal-root','#toast'].map(key=>[key,element()]));
  const callbacks = new Map();
  const timers = [], clearedTimers = [];
  const context = vm.createContext({
    ...engine, ...problem, URL, Response, AbortSignal:abortSignal, AbortController, structuredClone, console,
    location:{href:url,protocol:'https:'}, history:{replaceState(){}},
    localStorage:{getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value)},
    sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)},
    document:{activeElement:null,visibilityState:'visible',querySelector:key=>elements.get(key)||null,querySelectorAll:()=>[],getElementById:()=>null,addEventListener:(name,cb)=>callbacks.set(name,cb)},
    window:{MOONWOLF_CONFIG:{apiBase:configuredApi},addEventListener(){}}, navigator:{}, fetch,
    setTimeout:(callback,delay)=>{timers.push({callback,delay});return timers.length;},clearTimeout:id=>clearedTimers.push(id),setInterval(){},
  });
  vm.runInContext(source,context,{filename:'app.js'});
  await context.frontend.waitForConnect();
  return {app:context.frontend,saved,local,elements,timers,clearedTimers};
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
  const health=calls.find(call=>call.path==='/api/health');
  assert.equal(health.headers.Authorization,undefined,'public health checks must not cause bearer-token preflights');
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

test('a blank saved server uses the deployed default instead of the static website origin',async()=>{
  const calls=[], configuredApi='https://api.example.test';
  const {app}=await loadFrontend(async(url,options)=>{
    calls.push({url,...options});
    const path=new URL(url).pathname;
    return reply(path==='/api/session'?{token:'default-token',player:{id:'p1',name:'玩家'}}:baseResponse(path));
  },{configuredApi:configuredApi+'/',storedApi:''});
  assert.equal(app.state.apiBase,configuredApi);
  assert.equal(app.state.online,true);
  assert.ok(calls.length>=3);
  assert.ok(calls.every(call=>call.url.startsWith(configuredApi+'/api/')));
});

test('connection works without AbortSignal.timeout and clears its longer request timers',async()=>{
  const calls=[];
  const legacyAbortSignal={};
  const {app,timers,clearedTimers}=await loadFrontend(async(path,options)=>{
    calls.push({path,...options});
    return reply(path==='/api/session'?{token:'legacy-token',player:{id:'p1',name:'玩家'}}:baseResponse(path));
  },{abortSignal:legacyAbortSignal});
  assert.equal(legacyAbortSignal.timeout,undefined);
  assert.equal(app.state.online,true);
  assert.ok(calls.every(call=>call.signal instanceof AbortSignal&&!call.signal.aborted));
  assert.deepEqual(timers.slice(0,3).map(timer=>timer.delay),[30000,30000,20000]);
  assert.equal(clearedTimers.length,calls.length,'completed requests must cancel every timeout');
});

for(const [status,path,stage,message] of [
  [429,'/api/session','建立玩家会话','操作太频繁，请稍后再试'],
  [503,'/api/health','检查服务器','联机数据库尚未就绪'],
])test(`HTTP ${status} connection failures show the failed step and server explanation`,async()=>{
  const {app,elements}=await loadFrontend(async(current)=>current===path?reply({error:message},status):reply(baseResponse(current)));
  assert.equal(app.state.online,false);
  const html=elements.get('#app').innerHTML;
  assert.match(html,new RegExp(`${stage}：HTTP ${status}`));
  assert.ok(html.includes(message));
  assert.match(html,/检查服务器<\/a>/);
});

test('a network failure is distinguished from an HTTP response in the visible connection message',async()=>{
  const {app,elements}=await loadFrontend(async()=>{throw new TypeError('Failed to fetch');});
  assert.equal(app.state.online,false);
  const html=elements.get('#app').innerHTML;
  assert.match(html,/检查服务器：浏览器未收到可读取的响应/);
  assert.doesNotMatch(html,/HTTP \d{3}/);
  assert.match(html,/href="https:\/\/moonwolf\.test\/api\/health"/);
});
