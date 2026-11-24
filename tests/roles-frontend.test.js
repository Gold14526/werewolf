import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../web/engine.js';
import * as problem from '../web/problem-content.js';

// Exercise actual UI event handlers and outgoing payloads at the DOM boundary.
const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
  .replace(/^import .*?;\n/gm, '') + '\n;globalThis.frontend = {state,render,createModal,roomView,actionPanel,skillModal,confirmSkill,historyTable,waitForConnect:()=>connectPromise};';
const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
async function frontend() {
  const elements = new Map();
  const el = () => ({ innerHTML: '', textContent: '', value: '', checked: false, classList: { add() {}, remove() {}, toggle() {} }, focus() {} });
  for (const key of ['#app', '#modal-root', '#toast']) elements.set(key, el());
  const callbacks = new Map(), calls = [];
  const context = vm.createContext({
    ...engine, ...problem, URL, Response, AbortSignal, structuredClone, console,
    location: { href: 'https://moonwolf.test/', protocol: 'https:' }, history: { replaceState() {} },
    localStorage: { getItem() { return null; }, setItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {} },
    document: { activeElement: null, visibilityState: 'visible', querySelector: key => elements.get(key) || null,
      querySelectorAll: () => [], getElementById: () => null, addEventListener: (name, cb) => callbacks.set(name, cb) },
    window: { MOONWOLF_CONFIG: { apiBase: '' }, addEventListener() {} }, navigator: {},
    fetch: async (path, options) => {
      calls.push({ path, body: options.body && JSON.parse(options.body) });
      return reply(path === '/api/health' ? { ok: true, service: 'moonwolf' } : path === '/api/session' ?
        { token: 'test-token', player: { id: 'me', name: '测试玩家' } } : path === '/api/room' ? { room: null } :
          path === '/api/rooms' ? { rooms: [] } : path === '/api/history' ? { history: [] } : path === '/api/stats' ? { standings: [] } : {});
    }, setTimeout: () => 0, clearTimeout() {}, setInterval() {},
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const app = context.frontend;
  await app.waitForConnect();
  const click = async dataset => {
    const button = { dataset, disabled: false, isConnected: true };
    await callbacks.get('click')({ target: { closest: () => button }, preventDefault() {} });
  };
  const field = (key, props) => elements.set(key, { ...el(), ...props });
  const submit = id => callbacks.get('submit')({ preventDefault() {}, target: { id, dataset: {}, querySelector: () => null } });
  return { app, elements, calls, click, field, submit,callbacks };
}
function gameView(overrides = {}) {
  return { config: { ...engine.STANDARD_CONFIG, sheriff: true }, phase: 'discussion', phaseLabel: '轮流发言', round: 1,
    deadline: Date.now() + 90000, players: [{ id: 'me', name: '测试玩家', seat: 1, alive: true, role: 'knight' },
      { id: 'target', name: '目标玩家', seat: 2, alive: true }], myRole: 'knight', log: [], privateInfo: {}, actionable: false,
    currentSpeakerId: 'target', canSpeak: false, canWolfChat: false, canDuel: true, duelTargets: [{ id: 'target', name: '目标玩家', seat: 2 }],
    ...overrides };
}
function putInRoom(app, game) {
  app.state.room = { code: '123456', name: '测试房间', config: game.config, players: game.players, hostId: 'me', messages: [], game };
  app.state.page = 'room';
  app.render();
}

test('room creation saves a city game with zero villagers, two of each special wolf, and resets to standard', async () => {
  const ui = await frontend();
  ui.app.createModal();
  for (const name of ['狼王', '白狼王', '愚者', '骑士']) assert.match(ui.elements.get('#modal-root').innerHTML, new RegExp(`增加${name}`));
  assert.match(ui.elements.get('#modal-root').innerHTML, /type="checkbox" id="sheriff-enabled"/);
  assert.match(ui.elements.get('#modal-root').innerHTML, /<option value="75" selected>75 秒<\/option>/);
  for (const [role, delta, count] of [['wolf',-1,4],['villager',-1,4],['wolfKing',1,2],['whiteWolfKing',1,2],['fool',1,2],['seer',1,1]]) {
    for(let i=0;i<count;i++)await ui.click({count:role,delta:String(delta)});
  }
  ui.field('#other-night-seconds', { value: '40' }); ui.field('#witch-self-save', { value: 'none' });
  ui.field('#shuffle-seats', { checked: true }); ui.field('#sheriff-enabled', { checked: true });
  ui.field('#victory', { value: 'all' }); ui.field('#night-seconds', { value: '75' }); ui.field('#day-seconds', { value: '90' });
  ui.field('#room-name', { value: '角色测试' }); ui.field('#visibility', { value: 'private' });
  await ui.submit('create-form');
  const posted = ui.calls.find(c => c.path === '/api/rooms' && c.body)?.body;
  assert.equal(posted.config.sheriff, true);
  assert.equal(posted.config.shuffleSeats, true);
  assert.equal(posted.config.witchSelfSave, 'none');
  assert.equal(posted.config.otherNightSeconds, 40);
  assert.equal(posted.config.victory, 'all');
  assert.equal(posted.config.roles.villager, 0);
  assert.equal(posted.config.nightSeconds, 75);
  assert.equal(posted.config.roles.wolfKing, 2);
  assert.equal(posted.config.roles.whiteWolfKing, 2);
  assert.equal(posted.config.roles.fool, 2);
  assert.equal(Object.values(posted.config.roles).reduce((a, b) => a + b, 0), 11);
  await ui.click({ do: 'reset-config' });
  assert.equal(ui.elements.get('#sheriff-enabled').checked, false);
  assert.equal(ui.elements.get('#shuffle-seats').checked, false);
  assert.equal(ui.elements.get('#witch-self-save').value, 'first');
  assert.equal(Number(ui.elements.get('#other-night-seconds').value), 30);
  assert.equal(ui.app.state.config.roles.wolfKing, 0);
  assert.equal(Number(ui.elements.get('#night-seconds').value), 75);
  ui.app.state.room={code:'123456',config:{...engine.STANDARD_CONFIG,victory:'all',nightSeconds:90},players:[],messages:[],game:null};
  assert.match(ui.app.roomView(), /屠城 · 狼队 90 秒 · 其它行动 30 秒/);
});

test('sheriff signup, direction and transfer controls send engine-compatible payloads', async () => {
  const ui = await frontend();
  putInRoom(ui.app, gameView({ phase: 'sheriff_signup', actionable: true, canDuel: false, action: { type: 'sheriff_signup', targets: [] } }));
  ui.app.state.target = 'stale-target';
  await ui.click({ action: 'join' });
  assert.deepEqual(ui.calls.at(-1).body, { type: 'sheriff_signup', targetId: null, choice: 'join' });
  putInRoom(ui.app, gameView({ phase: 'sheriff_direction', actionable: true, canDuel: false, action: { type: 'sheriff_direction', targets: [] } }));
  assert.match(ui.app.actionPanel(ui.app.state.room.game), /从左侧开始/);
  await ui.click({ action: 'left' });
  assert.deepEqual(ui.calls.at(-1).body, { type: 'sheriff_direction', targetId: null, choice: 'left' });
  putInRoom(ui.app, gameView({ phase: 'sheriff_transfer', actionable: true, canDuel: false, action: { type: 'sheriff_transfer', targets: [] } }));
  assert.match(ui.app.actionPanel(ui.app.state.room.game), /撕毁警徽/);
  await ui.click({ action: 'skip' });
  assert.deepEqual(ui.calls.at(-1).body, { type: 'sheriff_transfer', targetId: null });
});

test('knight and white wolf king skill targets are separate from phase targets and need confirmation', async () => {
  const ui = await frontend();
  putInRoom(ui.app, gameView());
  ui.app.state.target = 'unrelated-phase-target';
  const before = ui.calls.length;
  await ui.click({ do: 'duel' });
  assert.equal(ui.calls.length, before);
  assert.match(ui.elements.get('#modal-root').innerHTML, /data-do="confirm-skill" disabled/);
  await ui.click({ skillTarget: 'target' });
  assert.equal(ui.app.state.target, 'unrelated-phase-target');
  await ui.click({ do: 'confirm-skill' });
  assert.deepEqual(ui.calls.at(-1).body, { type: 'duel', targetId: 'target' });
  assert.equal(ui.app.state.skill, null);
  putInRoom(ui.app, gameView({ myRole: 'whiteWolfKing', canDuel: false, canExplode: true,
    explodeTargets: [{ id: 'target', name: '目标玩家', seat: 2 }] }));
  await ui.click({ do: 'explode' });
  assert.match(ui.elements.get('#modal-root').innerHTML, /仅自爆，不带人/);
  await ui.click({ skillChoice: 'none' });
  await ui.click({ do: 'confirm-skill' });
  assert.deepEqual(ui.calls.at(-1).body, { type: 'explode', targetId: null });
});

test('a phase change dismisses a pending special skill and prevents accidental stale submission', async () => {
  const ui = await frontend();
  putInRoom(ui.app, gameView());
  await ui.click({ do: 'duel' });
  await ui.click({ skillTarget: 'target' });
  const before = ui.calls.length;
  ui.app.state.room.game.phase = 'vote';
  ui.app.state.room.game.canDuel = false;
  ui.app.render();
  assert.equal(ui.app.state.skill, null);
  assert.equal(ui.elements.get('#modal-root').innerHTML, '');
  await assert.rejects(ui.app.confirmSkill(), /阶段已变化/);
  assert.equal(ui.calls.length, before);
});

test('special wolves see the wolf channel, sheriff badges and revealed fool state render safely', async () => {
  const ui = await frontend();
  for (const role of ['wolfKing', 'whiteWolfKing']) {
    ui.app.state.problemTab = 'description';
    putInRoom(ui.app, gameView({myRole:role,privateInfo:{wolfTeammates:[]},sheriffId:'me',players: [
      { id: 'me', name: '测试玩家', seat: 1, alive: true, role },
      { id: 'target', name: '<script>坏名字</script>', seat: 2, alive: true, role: 'fool', foolRevealed: true },
    ] }));
    const html = ui.app.roomView();
    assert.doesNotMatch(html, /狼人队内频道/);
    assert.match(html, /badge sheriff/);
    assert.match(html, /已翻牌 · 无投票权/);
    assert.doesNotMatch(html, /<script>/);
    ui.app.state.room.game.phase = 'night';
    ui.app.state.room.game.canWolfChat = true;
    ui.app.state.problemTab = 'submit';
    ui.app.state.submitTab = 'file';
    const nightHtml = ui.app.roomView();
    assert.match(nightHtml, /狼人队内频道/);
    assert.doesNotMatch(nightHtml, /<script>/);
  }
  assert.match(ui.app.historyTable([{ code: '123456', winner: 'wolf', round: 1, endedAt: Date.now() }]), /狼人胜利/);
});

test('good special roles and both special wolves may be selected repeatedly',async()=>{
  const ui=await frontend();
  ui.app.createModal();
  const roles=ui.app.state.config.roles;
  for(const role of ['guard','seer','witch','hunter','fool','knight']){
    await ui.click({count:role,delta:'1'});await ui.click({count:role,delta:'1'});
    assert.ok(roles[role]>=2,role);
  }
  for(const role of ['wolfKing','whiteWolfKing']){
    await ui.click({count:role,delta:'1'});await ui.click({count:role,delta:'1'});
    assert.equal(roles[role],2,role);
  }
});

test('an editable guard choice is private, persists through polls, and needs confirmation to change',async()=>{
  const ui=await frontend();
  const game=gameView({phase:'night',phaseLabel:'守卫行动',myRole:'guard',actionable:true,submitted:true});
  game.action={type:'guard',deadline:game.deadline,targets:game.players,selected:{targetId:'target'}};
  putInRoom(ui.app,game);
  const background=ui.app.roomView();
  assert.equal((background.match(/data-deadline="/g)||[]).length,1);
  assert.match(background,/守卫行动/);assert.doesNotMatch(background,/已确认：守护/);
  await ui.click({do:'night-actions'});
  let html=ui.app.roomView();
  assert.equal((html.match(/data-deadline="/g)||[]).length,1);
  assert.match(html,/守卫行动/);assert.match(html,/已确认：守护 2 号 目标玩家/);
  const before=ui.calls.length;
  await ui.click({target:'me'});ui.app.render();
  assert.equal(ui.calls.length,before);
  html=ui.app.roomView();
  assert.match(html,/data-target="me" aria-pressed="true"/);assert.match(html,/已确认：守护 2 号/);
  await ui.click({action:'confirm'});
  assert.deepEqual(ui.calls.at(-1).body,{type:'guard',targetId:'me',round:1,turnDeadline:game.action.deadline});
});

test('Ctrl+Enter submits the permitted chat form once and leaves other editing and IME input alone', async () => {
  const ui=await frontend();
  const chatCalls=()=>ui.calls.filter(c=>c.path.startsWith('/api/chat'));
  async function press(channel,value,overrides={},disabled=false){
    let prevented=false,pending,submits=0;
    const button={disabled,dataset:{},isConnected:true};
    const form={dataset:{chat:channel},querySelector:key=>key==='[type="submit"]'?button:null,
      requestSubmit(submitter){
        assert.equal(submitter,button);submits++;
        pending=ui.callbacks.get('submit')({preventDefault(){},target:form});
      }};
    const target={id:'draft-'+channel,value,form};
    ui.callbacks.get('input')({target});
    ui.callbacks.get('keydown')({key:'Enter',ctrlKey:true,target,preventDefault(){prevented=true;},...overrides});
    await pending;
    return {prevented,submits};
  }
  putInRoom(ui.app,gameView({canSpeak:true,currentSpeakerId:'me'}));
  await ui.click({sidebarToggle:'discussion'});
  assert.match(ui.app.roomView(),/Ctrl\+Enter 发送/);
  assert.deepEqual(await press('public','  白天发言  '),{prevented:true,submits:1});
  assert.deepEqual(chatCalls().at(-1).body,{channel:'public',text:'白天发言'});
  putInRoom(ui.app,gameView({phase:'night',myRole:'wolf',privateInfo:{wolfTeammates:[]},canSpeak:false,canWolfChat:true}));
  assert.deepEqual(await press('wolf','夜间讨论'),{prevented:true,submits:1});
  assert.deepEqual(chatCalls().at(-1).body,{channel:'wolf',text:'夜间讨论'});
  assert.deepEqual(await press('public','还没轮到我'),{prevented:true,submits:0});
  assert.deepEqual(await press('wolf','空白',{ctrlKey:false}),{prevented:false,submits:0});
  assert.deepEqual(await press('wolf','拼音',{isComposing:true}),{prevented:false,submits:0});
  assert.deepEqual(await press('wolf','拼音',{keyCode:229}),{prevented:false,submits:0});
  assert.deepEqual(await press('wolf','尚未解除按键',{repeat:true}),{prevented:true,submits:0});
  assert.deepEqual(await press('wolf','   '),{prevented:true,submits:0});
  assert.deepEqual(await press('wolf','禁用',{},true),{prevented:true,submits:0});
  ui.app.state.busy=true;
  assert.deepEqual(await press('wolf','请求中'),{prevented:true,submits:0});
  ui.app.state.busy=false;
  assert.deepEqual(await press('wolf','代码',{target:{id:'code-editor',value:'code'}}),{prevented:false,submits:0});
  assert.equal(chatCalls().length,2);
});

function seatMarkup(html,seat){
  const card=html.match(new RegExp('<div class="seat [^"]*"><span class="seat-number">'+seat+'</span>[\\s\\S]*?<div class="seat-status">[\\s\\S]*?</div></div>'));
  assert.ok(card,'expected occupied seat '+seat);
  return card[0];
}
function tagBody(html){
  const body=html.match(/<div class="lg-side-content" id="sidebar-tags"[^>]*>([\s\S]*?)<button type="button" class="lg-disclosure"/);
  assert.ok(body);
  return body[1];
}

test('private team badges distinguish every wolf teammate from the hidden personal role and public reveals',async()=>{
  const ui=await frontend();
  const game=gameView({myRole:'whiteWolfKing',canDuel:false,players:[
    {id:'me',name:'甲',seat:1,alive:true,role:'whiteWolfKing'},
    {id:'wolf',name:'乙',seat:2,alive:true,role:'wolfKing'},
    {id:'fool',name:'丙',seat:3,alive:true,role:'fool',publicRole:'fool',foolRevealed:true},
    {id:'wolf2',name:'丁',seat:4,alive:false,role:'wolfKing'},
    {id:'white2',name:'戊',seat:5,alive:true,role:'whiteWolfKing'},
    {id:'regular',name:'己',seat:6,alive:false,role:'wolf'},
  ],privateInfo:{wolfTeammates:[{id:'wolf',name:'乙',seat:2}]}});
  putInRoom(ui.app,game);
  let html=ui.app.roomView();
  assert.doesNotMatch(seatMarkup(html,1),/seat-role|白狼王/);
  for(const [seat,role] of [[2,'狼王'],[4,'狼王'],[5,'白狼王'],[6,'狼人']]){
    assert.match(seatMarkup(html,seat),new RegExp('仅狼队可见：'+role));
    assert.doesNotMatch(seatMarkup(html,seat),/公开身份/);
  }
  assert.match(seatMarkup(html,3),/class="seat-role" aria-label="公开身份：愚者"><span class="badge god">愚者/);
  assert.doesNotMatch(tagBody(html),/你的身份|白狼王|狼人同伴/);
  await ui.click({sidebarToggle:'tags'});
  assert.match(tagBody(ui.app.roomView()),/你的身份：[\s\S]*白狼王[\s\S]*狼人同伴：2 号 乙/);
  game.players[1].publicRole='wolfKing';
  assert.match(seatMarkup(ui.app.roomView(),2),/公开身份：狼王/);
  assert.doesNotMatch(seatMarkup(ui.app.roomView(),2),/仅狼队可见/);
  game.players[0].publicRole='whiteWolfKing';
  html=ui.app.roomView();
  assert.match(seatMarkup(html,1),/公开身份：白狼王/);
  assert.doesNotMatch(tagBody(html),/你的身份|白狼王/);
  assert.match(tagBody(html),/狼人同伴：2 号 乙/);
  ui.app.state.room.isSpectator=true;
  assert.doesNotMatch(tagBody(ui.app.roomView()),/狼人同伴|你的身份|狼王/);
  assert.doesNotMatch(seatMarkup(ui.app.roomView(),4),/seat-role/);
  ui.app.state.room.isSpectator=false;
  game.myRole='seer';
  assert.doesNotMatch(seatMarkup(ui.app.roomView(),4),/seat-role/);
});

test('AFK shares the status area with speaking, sheriff and death; only settled deaths dim a card',async()=>{
  const ui=await frontend();
  const game=gameView({phase:'hunter',currentSpeakerId:'idle',sheriffId:'idle',players:[
    {id:'idle',name:'挂机者',seat:1,afk:true,alive:true},
    {id:'hunter',name:'等待开枪',seat:2,alive:true,publicRole:'hunter'},
    {id:'out',name:'已出局',seat:3,afk:true,alive:false,publicRole:'whiteWolfKing'},
  ]});
  putInRoom(ui.app,game);
  const html=ui.app.roomView(),idle=seatMarkup(html,1),pending=seatMarkup(html,2),out=seatMarkup(html,3);
  assert.match(idle,/<div class="seat-status">[\s\S]*挂机[\s\S]*正在发言[\s\S]*警长/);
  assert.doesNotMatch(idle,/class="seat [^"]*\bdead\b|出局<\/span>/);
  assert.doesNotMatch(pending,/class="seat [^"]*\bdead\b|出局<\/span>/);
  assert.match(pending,/公开身份：猎人/);
  assert.match(out,/class="seat [^"]*\bdead\b/);assert.match(out,/出局<\/span>.*挂机<\/span>/);
});

test('finished games and archived replays put every known role in the seat corner, leaving tags for algorithms',async()=>{
  const ui=await frontend();
  const game=gameView({phase:'finished',winner:'good',players:[
    {id:'me',name:'甲',seat:1,alive:true,role:'knight',publicRole:'knight'},
    {id:'other',name:'乙',seat:2,alive:false,role:'wolfKing'},
  ]});
  putInRoom(ui.app,game);
  for(const replay of [false,true]){
    if(replay){ui.app.state.replay=ui.app.state.room;ui.app.render();}
    if(!ui.app.state.sidebar.tags)await ui.click({sidebarToggle:'tags'});
    const html=ui.app.roomView();
    assert.match(seatMarkup(html,1),/公开身份：骑士/);
    assert.match(seatMarkup(html,2),/公开身份：狼王/);
    assert.match(tagBody(html),/树状数组/);
    assert.doesNotMatch(tagBody(html),/lg-role-roster|你的身份|狼王|骑士/);
  }
});

test('every viewer sees the same night phase and deadline in both panels; only the actor gets target controls',async()=>{
  const ui=await frontend();
  const base=Date.now();
  for(const [index,[type,label]] of [['guard','守卫行动'],['wolf','狼人行动'],['seer','预言家行动'],['witch','女巫行动']].entries()){
    const deadline=base+(index+1)*30000;
    for(const view of ['actor','villager','observer']){
      const g=gameView({phase:'night',phaseLabel:label,nightStages:[{type,label,deadline}],
        deadline,myRole:view==='actor'?type:view==='observer'?null:'villager',privateInfo:{},currentSpeakerId:null,
        actionable:view==='actor',canDuel:false,action:view==='actor'?{type,deadline,targets:[{id:'target',name:'目标玩家',seat:2}],choices:['skip','poison']}:null});
      putInRoom(ui.app,g);ui.app.state.room.isSpectator=view==='observer';
      for(const tab of ['description','submit']){
        ui.app.state.problemTab=tab;ui.app.state.submitTab='file';const html=ui.app.roomView();
        assert.match(html,new RegExp(label));
        assert.equal((html.match(/data-deadline="/g)||[]).length,1);
        assert.match(html,new RegExp('data-deadline="'+deadline+'"'));
        if(tab==='submit'&&view==='actor')assert.match(html,/data-target="target"/);
        else assert.doesNotMatch(html,/data-target="target"|已确认：/);
      }
    }
  }
});

test('a restored concurrent night shows a separate public countdown for each open role',async()=>{
  const ui=await frontend(),deadline=Date.now()+30000;
  const nightStages=[{type:'guard',label:'守卫行动',deadline},{type:'wolf',label:'狼人行动',deadline:deadline+45000}];
  const g=gameView({phase:'night',phaseLabel:'守卫行动、狼人行动',deadline,nightStages,myRole:null,actionable:false,action:null,currentSpeakerId:null});
  putInRoom(ui.app,g);ui.app.state.room.isSpectator=true;
  for(const tab of ['description','submit']){
    ui.app.state.problemTab=tab;ui.app.state.submitTab='file';
    const html=ui.app.roomView();
    assert.equal((html.match(/data-deadline="/g)||[]).length,2);
    for(const stage of nightStages)assert.ok(html.includes(stage.label+' <strong class="timer" data-deadline="'+stage.deadline+'"'));
    assert.doesNotMatch(html,/data-target=|已确认：/);
  }
});

test('wolves review each resolved night and the team feed by day; drafts and actions resume at night',async()=>{
  const ui=await frontend();
  const game=gameView({myRole:'wolfKing',phase:'night',phaseLabel:'狼人行动',actionable:true,canWolfChat:true,
    action:{type:'wolf',deadline:Date.now()+60000,targets:[{id:'target',name:'目标玩家',seat:2}]},
    privateInfo:{wolfTeammates:[],wolfHistory:[]}});
  putInRoom(ui.app,game);
  await ui.click({do:'night-actions'});
  assert.doesNotMatch(ui.app.roomView(),/狼队行动记录/);
  ui.callbacks.get('input')({target:{id:'draft-wolf',value:'准备夜里再发的草稿'}});
  ui.app.state.room.messages=[{id:'private',playerId:'me',name:'测试玩家',seat:1,text:'队内原话 <b>讨论</b>',channel:'wolf'}];
  game.phase='discussion';game.phaseLabel='轮流发言';game.action=null;game.actionable=false;game.canWolfChat=false;
  game.privateInfo.wolfHistory=[
    {round:1,targetId:'target',ballots:[{playerId:'me',targetId:'target'}]},
    {round:2,targetId:null,ballots:[{playerId:'me',targetId:null}]},
    {round:3,targetId:'target',ballots:null},
  ];
  let html=ui.app.roomView();
  assert.match(html,/白天只读/);assert.match(html,/队内原话 &lt;b&gt;讨论&lt;\/b&gt;/);
  assert.match(html,/第 1 夜[\s\S]*最终刀口：2 号 目标玩家[\s\S]*1 号 测试玩家 → 2 号 目标玩家/);
  assert.match(html,/第 2 夜[\s\S]*最终刀口：空刀[\s\S]*1 号 测试玩家 → 空刀/);
  assert.match(html,/第 3 夜[\s\S]*本夜未保存逐人记录/);
  assert.doesNotMatch(html,/id="draft-wolf"|data-chat="wolf"|data-action="confirm"|data-target=|准备夜里再发的草稿/);
  const sent=ui.calls.length;
  await ui.callbacks.get('submit')({preventDefault(){},target:{id:'',dataset:{chat:'wolf'},querySelector:()=>null}});
  assert.equal(ui.calls.length,sent);
  await ui.click({submitTab:'code'});assert.doesNotMatch(ui.app.roomView(),/狼队行动记录|队内原话/);
  await ui.click({submitTab:'file'});
  for(const [myRole,isSpectator,info,alive] of [['seer',false,game.privateInfo,true],['wolfKing',true,game.privateInfo,true],['wolfKing',false,{},true],['wolfKing',false,game.privateInfo,false]]){
    const hidden=gameView({...game,myRole,privateInfo:info,players:game.players.map(p=>({...p,alive:p.id==='me'?alive:p.alive}))});
    putInRoom(ui.app,hidden);ui.app.state.room.isSpectator=isSpectator;
    ui.app.state.room.messages=[{id:'private',text:'队内原话',channel:'wolf'}];
    assert.doesNotMatch(ui.app.roomView(),/狼队行动记录|狼人队内频道|队内原话/);
  }
  game.phase='night';game.phaseLabel='狼人行动';game.actionable=true;game.canWolfChat=true;
  game.action={type:'wolf',deadline:Date.now()+60000,targets:[{id:'target',name:'目标玩家',seat:2}]};
  putInRoom(ui.app,game);
  html=ui.app.roomView();
  assert.match(html,/第 1 夜[\s\S]*最终刀口：2 号 目标玩家/);
  assert.match(html,/id="draft-wolf"[\s\S]*?准备夜里再发的草稿<\/textarea>/);
  assert.match(html,/data-action="confirm"/);
});
