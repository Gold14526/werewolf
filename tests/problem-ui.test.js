import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as engine from '../web/engine.js';
import * as problem from '../web/problem-content.js';

// Drive the actual browser handlers, checking visible controls and their effects.
// Network replies are authoritative room snapshots, as with the real poll loop.
const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
  .replace(/^import\s[\s\S]*?;\r?\n/gm, '') +
  '\n;globalThis.frontend={state,render,roomView,refreshData,updateClock,waitForConnect:()=>connectPromise};';
const reply = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const json = value => JSON.parse(JSON.stringify(value));

async function frontend(savedStorage = new Map()) {
  const elements = new Map(), callbacks = new Map(), calls = [], copied = [], navigations = [];
  let serverRoom = null;
  const el = () => ({ innerHTML: '', textContent: '', value: '', checked: false, dataset: {},
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollLeft: 0,
    classList: { add() {}, remove() {}, toggle() {} }, focus() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
  for (const key of ['#app', '#modal-root', '#toast']) elements.set(key, el());
  const document = {
    title: '', activeElement: null, visibilityState: 'visible',
    querySelector: key => elements.get(key) || null,
    querySelectorAll: () => [], getElementById: id => elements.get('#' + id) || null,
    addEventListener: (name, callback) => callbacks.set(name, callback),
  };
  const location = { href: 'https://moonwolf.test/', protocol: 'https:' };
  const context = vm.createContext({
    ...engine, ...problem, URL, Response, AbortSignal, structuredClone, console,
    location, history: { replaceState(...args) { navigations.push(args); } }, document,
    localStorage: { getItem: key => savedStorage.get(key) ?? null, setItem: (key, value) => savedStorage.set(key, String(value)) },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    window: { MOONWOLF_CONFIG: { apiBase: '' }, addEventListener() {}, scrollTo() {} },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    fetch: async (url, options = {}) => {
      const {pathname:path,search}=new URL(url,location.href);
      const body=options.body&&JSON.parse(options.body);
      calls.push({ path,search,method:options.method||'GET',body });
      if(path==='/api/action'&&['vote','sheriff_vote'].includes(body.type)){
        serverRoom.game.submitted=true;
        serverRoom.game.myVoteTargetId=body.targetId;
        return reply({room:serverRoom});
      }
      return reply(path === '/api/health' ? { ok: true, service: 'moonwolf' } :
        path === '/api/session' ? { token: 'test-token', player: { id: 'me', name: '测试玩家' } } :
          path === '/api/room' ? { room: serverRoom } : path === '/api/rooms' ? { rooms: [] } :
            path === '/api/history' ? { history: [] } : path === '/api/stats' ? { standings: [] } : {});
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval() {},
  });
  vm.runInContext(source, context, { filename: 'app.js' });
  const app = context.frontend;
  await app.waitForConnect();
  const click = async dataset => {
    const button = { dataset, disabled: false, isConnected: true };
    await callbacks.get('click')({ target: { closest: () => button }, preventDefault() {} });
    return button;
  };
  const field = (id, properties = {}) => {
    const element = { ...el(), id, ...properties };
    elements.set('#' + id, element);
    return element;
  };
  const edit = async (id, value, event = 'input') => {
    const target = elements.get('#' + id) || field(id);
    target.value = value;
    await callbacks.get(event)?.({ target });
    return target;
  };
  const submit = async (id, dataset = {}) => callbacks.get('submit')({
    preventDefault() {}, target: { id, dataset, querySelector: () => null },
  });
  const putInRoom = (game, overrides = {}) => {
    serverRoom = { code: '123456', name: '测试房间', config: game?.config || engine.STANDARD_CONFIG,
      players: game?.players || [], hostId: 'me', visibility: 'private', messages: [], game, ...overrides };
    app.state.room = json(serverRoom);
    app.state.page = 'room';
    app.render();
  };
  return { app, elements, calls, copied, navigations, location, document, storage: savedStorage,
    click, field, edit, submit, putInRoom, window:context.window, html: () => elements.get('#app').innerHTML,
    setServerRoom: room => { serverRoom = json(room); } };
}

function gameView(overrides = {}) {
  return {
    config: { ...engine.STANDARD_CONFIG, sheriff: true }, phase: 'vote', phaseLabel: '放逐投票',
    round: 1, deadline: Date.now() + 90000,
    players: [
      { id: 'me', name: '测试玩家', seat: 1, alive: true, role: 'villager' },
      { id: 'target', name: '目标玩家', seat: 2, alive: true },
      { id: 'dead', name: '已出局玩家', seat: 3, alive: false },
      { id: 'outside', name: '非候选玩家', seat: 4, alive: true },
    ],
    myRole: 'villager', log: [], privateInfo: {}, actionable: true, submitted: false,
    action: { type: 'vote', targets: [{ id: 'target', name: '目标玩家', seat: 2 }] },
    canSpeak: false, canWolfChat: false, canDuel: false, canExplode: false,
    ...overrides,
  };
}
const actions = ui => ui.calls.filter(call => call.path === '/api/action');
const options = html => [...html.matchAll(/<option\b[^>]*value="([^"]+)"[^>]*>([^<]*)<\/option>/g)]
  .map(match => ({ value: match[1], label: match[2] }));

test('the problem shell keeps twelve lobby seats and real room entry controls', async () => {
  const ui = await frontend();
  const html = ui.html();
  assert.match(html, /P4899 \[IOI 2018\] werewolf 狼人/);
  assert.match(html, /题目背景/);
  assert.match(html, /题目描述/);
  assert.match(html, /相关讨论/);
  assert.equal((html.match(/class="[^"]*\bseat empty\b/g) || []).length, 12);
  for (const action of ['match', 'create', 'join-modal', 'demo']) assert.match(html, new RegExp(`data-do="${action}"`));
});

test('avatar votes immediately and both another avatar and abstention replace the ballot', async () => {
  const ui=await frontend();
  const game=gameView();
  game.action.targets.push(game.players[3]);
  ui.putInRoom(game);
  assert.match(ui.html(),/<button[^>]*data-target="target"/);
  assert.doesNotMatch(ui.html(),/data-action="confirm"|data-target="(?:me|dead)"/);
  await Promise.all([ui.click({target:'target'}),ui.click({target:'outside'}),ui.click({action:'abstain'})]);
  assert.match(ui.html(),/当前已弃权/);
  await ui.click({target:'target'});
  assert.deepEqual(actions(ui).map(c=>c.body),['target','outside',null,'target'].map(targetId=>({type:'vote',targetId,turnDeadline:game.deadline})));
  assert.match(ui.html(),/当前投给 2 号 目标玩家/);
  assert.ok(actions(ui).every(c=>c.search==='?code=123456'));
});

test('a sheriff voter can revise a submitted ballot and only eligible avatars accept clicks', async () => {
  const ui=await frontend();
  const game=gameView({phase:'sheriff_vote',phaseLabel:'警长投票',submitted:true,myVoteTargetId:null,
    action:{type:'sheriff_vote',targets:[{id:'target',name:'目标玩家',seat:2}]}});
  ui.putInRoom(game);
  for(const id of ['me','dead','outside','missing'])await ui.click({target:id});
  assert.equal(actions(ui).length,0);
  await ui.click({target:'target'});
  assert.deepEqual(actions(ui).at(-1).body,{type:'sheriff_vote',targetId:'target',turnDeadline:game.deadline});
});

test('non-voters and replay views cannot cast or change ballots', async () => {
  const ui=await frontend();
  ui.putInRoom(gameView({actionable:false,submitted:true}));
  await ui.click({target:'target'});await ui.click({action:'abstain'});
  ui.putInRoom(gameView());
  ui.app.state.replay=json(ui.app.state.room);ui.app.render();
  await ui.click({target:'target'});await ui.click({action:'abstain'});
  assert.equal(actions(ui).length,0);
});

test('a room poll removing a target prevents a stale avatar click from sending a ballot', async () => {
  const ui=await frontend();
  ui.putInRoom(gameView());
  const updated=json(ui.app.state.room);
  updated.game.action.targets=[];
  updated.game.players.find(p=>p.id==='target').alive=false;
  ui.setServerRoom(updated);await ui.app.refreshData();
  await ui.click({target:'target'});
  assert.equal(actions(ui).length,0);
});

test('code language and escaped draft survive tab changes, live polling and a new page session', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  await ui.click({ problemTab: 'submit' });
  await ui.click({ submitTab: 'code' });
  const languageChoices = options(ui.html());
  for (const label of [/C\+\+\s*17/i, /C\+\+\s*20/i, /^C(?:\s|$)/, /Python\s*3/i, /Java\s*17/i, /Rust/i, /JavaScript/i]) {
    assert.ok(languageChoices.some(choice => label.test(choice.label)), 'missing language ' + label);
  }
  const language = languageChoices.find(choice => /Python/i.test(choice.label)).value;
  const draft = 'print("狼人 < & >")\n# </textarea><script>bad()</script>\n';
  await ui.edit('code-editor', draft);
  await ui.edit('code-language', language, 'change');
  assert.equal(ui.app.state.codeDraft, draft);
  assert.equal(ui.app.state.codeLanguage, language);
  await ui.click({ submitTab: 'file' });
  await ui.click({ problemTab: 'description' });
  const updated = json(ui.app.state.room);
  updated.messages.push({ name: '目标玩家', seat: 2, text: '新的公开消息', channel: 'public', at: Date.now() });
  ui.setServerRoom(updated);
  await ui.app.refreshData();
  await ui.click({ problemTab: 'submit' });
  await ui.click({ submitTab: 'code' });
  ui.app.render();
  assert.equal(ui.app.state.codeDraft, draft);
  assert.equal(ui.app.state.codeLanguage, language);
  assert.match(ui.html(), /&lt;\/textarea&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(ui.html(), /<script>bad\(\)<\/script>/);
  const reloaded = await frontend(ui.storage);
  assert.equal(reloaded.app.state.codeDraft, draft);
  assert.equal(reloaded.app.state.codeLanguage, language);
});

test('copy code copies the complete current draft without a game action', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  await ui.click({ problemTab: 'submit' });
  await ui.edit('code-editor', 'int main() {\n  return 0;\n}\n');
  const before = ui.calls.length;
  await ui.click({ do: 'copy-code' });
  assert.deepEqual(ui.copied, ['int main() {\n  return 0;\n}\n']);
  assert.equal(ui.calls.length, before);
});

test('a live poll preserves editor focus, selection and scroll when the DOM is replaced', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  await ui.click({ problemTab: 'submit' });
  const draft = 'int main() {\n' + '  // code being edited\n'.repeat(40) + '}\n';
  const oldEditor = ui.field('code-editor', { value: draft, selectionStart: 18, selectionEnd: 45,
    scrollTop: 240, scrollLeft: 35 });
  ui.document.activeElement = oldEditor;
  // Model innerHTML replacing the focused textarea with a fresh DOM node.
  const root = ui.elements.get('#app');
  let markup = root.innerHTML;
  Object.defineProperty(root, 'innerHTML', {
    get: () => markup,
    set: value => {
      markup = value;
      ui.document.activeElement = null;
      const editor = ui.field('code-editor');
      editor.focus = () => { ui.document.activeElement = editor; };
    },
  });
  const updated = json(ui.app.state.room);
  updated.game.players[1].name = '服务器更新的昵称';
  ui.setServerRoom(updated);
  await ui.app.refreshData();
  const editor = ui.elements.get('#code-editor');
  assert.notEqual(editor, oldEditor);
  assert.equal(ui.document.activeElement, editor);
  assert.equal(editor.value, draft);
  assert.equal(editor.selectionStart, 18);
  assert.equal(editor.selectionEnd, 45);
  assert.equal(editor.scrollTop, 240);
  assert.equal(editor.scrollLeft, 35);
  assert.equal(ui.app.state.codeDraft, draft);
  assert.equal(actions(ui).length, 0);
});

test('提交评测 is inert even with a real vote selected and a live room', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  await ui.click({ target: 'target' });
  await ui.click({ problemTab: 'submit' });
  await ui.click({ submitTab: 'code' });
  await ui.edit('code-editor', 'int main() { return 0; }');
  const submitTag = ui.html().match(/<button\b[^>]*data-do="code-submit"[^>]*>/)?.[0];
  assert.ok(submitTag, 'code submission has its own handler');
  assert.match(submitTag, /type="button"/);
  assert.doesNotMatch(submitTag, /data-action=/);
  const before = { state: json(ui.app.state), calls: ui.calls.length, storage: [...ui.storage],
    html: ui.html(), url: ui.location.href, navigations: ui.navigations.length };
  const button = await ui.click({ do: 'code-submit' });
  assert.deepEqual(json(ui.app.state), before.state);
  assert.equal(ui.calls.length, before.calls);
  assert.deepEqual([...ui.storage], before.storage);
  assert.equal(ui.html(), before.html);
  assert.equal(ui.location.href, before.url);
  assert.equal(ui.navigations.length, before.navigations);
  assert.equal(button.disabled, false);
  assert.equal(actions(ui).length, 1);
});

test('night action controls and wolf chat exist only in 提交文件; code area stays independent', async () => {
  const ui = await frontend();
  const deadline=Date.now()+60000;
  ui.putInRoom(gameView({ phase:'night',phaseLabel:'狼人行动',myRole:'wolfKing',canWolfChat:true,deadline,
    action:{type:'wolf',deadline,targets:[{id:'target',name:'目标玩家',seat:2}]} }));
  assert.match(ui.html(), /data-do="night-actions"/);
  assert.doesNotMatch(ui.html(), /data-chat="wolf"|data-action="confirm"/);
  await ui.click({ do: 'night-actions' });
  assert.equal(ui.app.state.problemTab, 'submit');
  assert.equal(ui.app.state.submitTab, 'file');
  assert.match(ui.html(), /data-chat="wolf"/);
  assert.match(ui.html(), /data-action="confirm"/);
  assert.doesNotMatch(ui.html(), /id="code-editor"/);
  await ui.click({ target: 'target' });
  assert.equal(actions(ui).length, 0);
  await ui.click({ action: 'confirm' });
  assert.deepEqual(actions(ui).at(-1).body, {type:'wolf',targetId:'target',round:1,turnDeadline:deadline});
  await ui.click({ submitTab: 'code' });
  assert.match(ui.html(), /id="code-editor"/);
  assert.doesNotMatch(ui.html(), /data-chat="wolf"|data-action="confirm"/);
  assert.doesNotMatch(ui.html(), /data-chat="public"/);
  await ui.click({ sidebarToggle: 'discussion' });
  assert.equal((ui.html().match(/data-chat="public"/g) || []).length, 1);
});

test('相关讨论 is the inline public channel and the current speaker can send and finish speaking', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView({ phase: 'discussion', phaseLabel: '轮流发言', currentSpeakerId: 'me',
    canSpeak: true, action: { type: 'pass', targets: [] } }), {
    messages: [{ name: '<script>名字</script>', seat: 2, text: '<img src=x onerror=bad()>', channel: 'public', at: Date.now() }],
  });
  await ui.click({ sidebarToggle: 'discussion' });
  const html = ui.html();
  assert.match(html, /相关讨论/);
  assert.equal((html.match(/data-chat="public"/g) || []).length, 1);
  assert.match(html, /id="draft-public"/);
  assert.match(html, /data-do="pass"/);
  assert.doesNotMatch(html, /<script>名字<\/script>|<img src=x onerror=bad\(\)>/);
  await ui.edit('draft-public', '我是好人，请听我发言。');
  await ui.submit('chat-public', { chat: 'public' });
  assert.deepEqual(ui.calls.filter(call => call.path === '/api/chat').map(call => call.body),
    [{ text: '我是好人，请听我发言。', channel: 'public' }]);
  await ui.click({ do: 'pass' });
  assert.deepEqual(actions(ui).map(call => call.body), [{ type: 'pass',turnDeadline:ui.app.state.room.game.deadline }]);
});

test('sidebar toggles independently, hides private roles in every tab, and hides them again when the room changes', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView({
    phase:'wolf', phaseLabel:'狼人行动', myRole:'whiteWolfKing', privateInfo:{wolfTeammates:[{id:'target', seat:2, name:'目标玩家'}]},
    canExplode:true, canWolfChat:true,
  }));
  const expanded = key => ui.html().includes('data-sidebar-toggle="' + key + '" aria-expanded="true"');
  assert.equal(expanded('tags') || expanded('discussion') || expanded('recommendations'), false);
  assert.doesNotMatch(ui.html(), /你的身份：|狼人同伴：|白狼王|data-chat="public"|P5055/);
  await ui.click({ sidebarToggle:'tags' });
  await ui.click({ sidebarToggle:'recommendations' });
  assert.match(ui.html(), /你的身份：[\s\S]*?白狼王/);
  assert.match(ui.html(), /狼人同伴：2 号 目标玩家/);
  assert.match(ui.html(), /href="https:\/\/www\.luogu\.com\.cn\/problem\/P5055"/);
  assert.match(ui.html(), /Kruskal 重构树/);
  await ui.click({ sidebarToggle:'discussion' });
  await ui.edit('draft-public', '下一轮的草稿');
  await ui.click({ sidebarToggle:'tags' });
  await ui.click({ sidebarToggle:'discussion' });
  await ui.click({ do:'night-actions' });
  assert.match(ui.html(), /data-chat="wolf"/);
  assert.doesNotMatch(ui.html(), /你的身份：|狼人同伴：|白狼王|下一轮的草稿/);
  assert.ok(expanded('recommendations'));
  await ui.click({ sidebarToggle:'tags' });
  await ui.click({ sidebarToggle:'discussion' });
  const updated = json(ui.app.state.room);
  updated.messages.push({name:'目标玩家', text:'轮询消息', channel:'public', at:Date.now()});
  ui.setServerRoom(updated);
  await ui.app.refreshData();
  assert.ok(expanded('tags') && expanded('discussion') && expanded('recommendations'));
  assert.match(ui.html(), /下一轮的草稿/);
  await ui.click({ problemTab:'description' });
  ui.putInRoom(updated.game,{code:'654321'});
  assert.equal(expanded('tags'),false);
  assert.doesNotMatch(ui.html(), /你的身份：|狼人同伴：|白狼王/);
});

test('closing the ad survives renders without making a request', async () => {
  const ui = await frontend(), before = ui.calls.length;
  assert.match(ui.html(), /luogu-recommended\.png/);
  await ui.click({do:'dismiss-ad'});
  await ui.click({problemTab:'submit'});
  assert.doesNotMatch(ui.html(), /luogu-recommended\.png/);
  assert.equal(ui.calls.length,before);
});

test('witch confirms the actual victim for antidote and can replace it with a poison or a pass before deadline', async () => {
  const ui=await frontend();
  const witch=gameView({phase:'night',phaseLabel:'女巫行动',myRole:'witch'});
  const victim=witch.players[1];
  witch.privateInfo={nightVictim:victim,potions:{save:true,poison:true}};
  witch.action={type:'witch',targets:witch.players.filter(p=>p.alive),choices:['skip','save','poison'],deadline:witch.deadline};
  ui.putInRoom(witch);
  assert.equal((ui.html().match(/data-deadline="/g)||[]).length,1);
  assert.doesNotMatch(ui.html(),/今夜被刀|使用解药|用毒目标/);
  await ui.click({do:'night-actions'});
  assert.equal((ui.html().match(/data-deadline="/g)||[]).length,1);
  assert.match(ui.html(),new RegExp(`data-deadline="${witch.action.deadline}"`));
  assert.match(ui.html(),/对 2 号 目标玩家 使用解药/);
  await ui.click({target:'outside'});await ui.click({action:'save'});
  assert.equal(actions(ui).length,0);
  await ui.click({target:'target'});await ui.click({action:'save'});
  const turn={round:witch.round,turnDeadline:witch.action.deadline};
  assert.deepEqual(actions(ui).at(-1).body,{type:'witch',targetId:'target',choice:'save',...turn});
  witch.submitted=true;
  witch.action.selected={targetId:'target',choice:'save'};
  ui.putInRoom(witch);
  assert.match(ui.html(),/已确认：对 2 号 目标玩家 使用解药/);
  assert.match(ui.html(),/data-target="target" aria-pressed="true"/);
  await ui.click({target:'outside'});
  assert.equal(actions(ui).length,1);
  await ui.click({action:'poison'});
  assert.deepEqual(actions(ui).at(-1).body,{type:'witch',targetId:'outside',choice:'poison',...turn});
  witch.action.selected={targetId:'outside',choice:'poison'};
  ui.putInRoom(witch);
  assert.match(ui.html(),/已确认：对 4 号 非候选玩家 使用毒药/);
  await ui.click({action:'skip'});
  assert.deepEqual(actions(ui).at(-1).body,{type:'witch',targetId:null,choice:'skip',...turn});
  witch.action.selected={targetId:null,choice:'skip'};
  ui.putInRoom(witch);
  assert.match(ui.html(),/已确认：放弃行动/);
  witch.action.choices=['skip','poison'];
  witch.privateInfo.nightVictim=null;
  ui.putInRoom(witch);
  assert.match(ui.html(),/无人被刀/);assert.doesNotMatch(ui.html(),/data-action="save"/);
  witch.privateInfo={potions:{save:false,poison:true}};
  ui.putInRoom(witch);
  assert.doesNotMatch(ui.html(),/无人被刀|今夜被刀|data-action="save"/);
});

test('the current speaker sees the last 15 seconds under the input and an AFK player explicitly returns', async () => {
  const ui=await frontend();
  const game=gameView({phase:'discussion',phaseLabel:'轮流发言',currentSpeakerId:'me',canSpeak:true,
    action:{type:'pass',targets:[]},inactivityDeadline:Date.now()+15000});
  ui.putInRoom(game);
  await ui.click({sidebarToggle:'discussion'});
  assert.match(ui.html(),/id="draft-public"[\s\S]*?<\/textarea><small id="afk-warning"/);
  const label=ui.field('afk-warning',{dataset:{inactivity:String(Date.now()+14500)}});
  ui.app.updateClock();
  assert.equal(label.hidden,false);assert.match(label.textContent,/若再 15 秒不发言，将被判定为挂机/);
  label.dataset.inactivity=Date.now()+16001;ui.app.updateClock();assert.equal(label.hidden,true);
  await ui.edit('code-editor','writing code');
  assert.equal(actions(ui).length,0);
  await ui.edit('draft-public','正在发言');
  assert.deepEqual(actions(ui).at(-1).body,{type:'typing',turnDeadline:game.deadline});
  ui.putInRoom({...game,myAfk:true,actionable:false,currentSpeakerId:'target',canSpeak:false,inactivityDeadline:null});
  assert.match(ui.html(),/data-do="return">回到游戏/);
  await ui.click({do:'return'});assert.deepEqual(actions(ui).at(-1).body,{type:'return'});
});

test('empty seats accept seat requests; spectators can navigate between games and see public chat only', async () => {
  const ui=await frontend();
  const players=[{id:'me',name:'测试玩家',seat:1,ready:true}];
  ui.putInRoom(null,{players});
  assert.match(ui.html(),/data-do="observe"/);
  assert.match(ui.html(),/data-seat="2"/);assert.doesNotMatch(ui.html(),/data-seat="1"/);
  await ui.click({seat:'2'});await ui.click({do:'observe'});
  assert.deepEqual(ui.calls.filter(c=>c.path==='/api/seat').map(c=>c.body),[{seat:2},{seat:null}]);
  const publicView=gameView({myRole:null,submitted:false,action:null,actionable:false});
  ui.app.state.memberships=[{code:'123456',name:'原来的房间'},{code:'456789',name:'新房间'}];
  ui.putInRoom(publicView,{isSpectator:true,messages:[
    {system:true,at:1,text:'小张加入观战席。'},{playerId:'target',name:'目标玩家',seat:4,at:2,text:'大家好'},
    {playerId:'target',name:'目标玩家',seat:null,at:3,text:'旧座号未知'}]});
  await ui.click({sidebarToggle:'discussion'});
  assert.match(ui.html(),/小张加入观战席/);assert.match(ui.html(),/4 号 目标玩家<\/strong> 大家好/);
  assert.match(ui.html(),/<strong>目标玩家<\/strong> 旧座号未知/);
  assert.doesNotMatch(ui.html(),/id="draft-public"|data-seat=|data-target=|data-do="ready"/);
  assert.match(ui.html(),/data-do="leave"/);assert.match(ui.html(),/id="switch-room"/);
  await ui.click({page:'lobby'});
  assert.match(ui.html(),/data-do="match"/);
  await ui.edit('switch-room','456789','change');
  assert.deepEqual(ui.calls.filter(c=>c.path==='/api/join').at(-1).body,{code:'456789'});
});

test('public and wolf drafts remain scoped to their original room when switching games', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  await ui.edit('draft-public', '第一间的草稿');
  await ui.edit('draft-wolf', '第一间的狼队草稿');
  ui.putInRoom(gameView(), {code:'654321'});
  assert.equal(ui.app.state.draft, '');
  assert.equal(ui.app.state.wolfDraft, '');
  await ui.edit('draft-public', '第二间的草稿');
  ui.putInRoom(gameView());
  assert.equal(ui.app.state.draft, '第一间的草稿');
  assert.equal(ui.app.state.wolfDraft, '第一间的狼队草稿');
  ui.putInRoom(gameView(), {code:'654321'});
  assert.equal(ui.app.state.draft, '第二间的草稿');
  assert.equal(ui.app.state.wolfDraft, '');
});

// These nodes implement the same insertion and removal semantics as the DOM.
// The browser fixture in tests/chat-scroll.browser.html also samples animation frames.
function domElement(name, attrs = {}, children = []) {
  const node = {nodeName:name, nodeType:1, id:attrs.id || '', childNodes:[], parentNode:null,
    get attributes() { return Object.entries(attrs).map(([name,value]) => ({name,value})); },
    getAttributeNames:() => Object.keys(attrs),
    getAttribute:key => attrs[key] ?? null,
    hasAttribute:key => key in attrs,
    setAttribute(key,value) { attrs[key] = value; },
    removeAttribute(key) { delete attrs[key]; },
    get children() { return this.childNodes; },
    get firstElementChild() { return this.childNodes[0] || null; },
    get lastElementChild() { return this.childNodes.at(-1) || null; },
    get firstChild() { return this.firstElementChild; },
    get nextSibling() { const list = this.parentNode.childNodes;return list[list.indexOf(this)+1] || null; },
    isEqualNode(other) { return this === other; },
    remove() {
      if (!this.parentNode) return;
      const list = this.parentNode.childNodes;
      list.splice(list.indexOf(this),1);
      this.parentNode = null;
    },
    insertBefore(child, next) {
      child.remove();
      this.childNodes.splice(next ? this.childNodes.indexOf(next) : this.childNodes.length,0,child);
      child.parentNode = this;
    },
    getBoundingClientRect() { return {top:0, bottom:18}; },
  };
  for (const child of children) node.insertBefore(child,null);
  return node;
}

test('a room poll appends to the mounted feed without interim scroll, detach, or refocus', async () => {
  for (const composing of [false,true]) {
    const ui = await frontend();
    ui.putInRoom(gameView());
    await ui.click({sidebarToggle:'discussion'});
    const line = n => domElement('DIV',{'data-entry':'m:' + n});
    const feed = domElement('DIV',{id:'feed-public'},[line(1),line(2)]);
    const draft = domElement('TEXTAREA',{id:'draft-public'});
    const form = domElement('FORM',{},[draft]);
    const root = domElement('DIV',{id:'app'},[feed,form]);
    const room = json(ui.app.state.room);
    const pageScrolls = [], feedScrolls = [];
    let top = 130, count = 2;
    Object.defineProperties(feed,{
      scrollHeight:{get:() => 500 + 25 * feed.childNodes.length},
      clientHeight:{value:200},
      scrollTop:{get:() => top, set(y) {feedScrolls.push(y);top=y;}},
    });
    ui.elements.set('#app',root);
    ui.elements.set('#draft-public',draft);
    ui.document.activeElement = composing ? draft : null;
    draft.value = '输入法候选中';
    draft.selectionStart = 1; draft.selectionEnd = 3;
    ui.document.querySelectorAll = s => s === '.chat-feed' ? [feed] : [];
    ui.window.scrollY = 720;
    ui.window.scrollTo = (...args) => pageScrolls.push(args);
    ui.document.createElement = () => ({content:domElement('template',{},[
      domElement('DIV',{id:'feed-public'},Array.from({length:count},(_,i) => line(i+1))),
      domElement('FORM',{},[domElement('TEXTAREA',{id:'draft-public'})]),
    ])});
    const liveLine = feed.firstChild;
    for (const value of [3,4,4]) {
      if (count === 3) top = feed.scrollHeight - feed.clientHeight;
      count = value;
      room.messages.push({name:'玩家',seat:2,text:'消息' + room.messages.length,at:Date.now()});
      ui.setServerRoom(room);
      await ui.app.refreshData();
      assert.equal(feed.children.length, count);
      assert.equal(feed.firstChild, liveLine);
      assert.deepEqual(root.childNodes, [feed,form]);
      assert.equal(form.firstChild,draft);
      assert.equal(ui.document.activeElement,composing ? draft : null);
      assert.equal(draft.value,'输入法候选中');
      assert.deepEqual([draft.selectionStart,draft.selectionEnd],[1,3]);
    }
    assert.deepEqual(pageScrolls,[]);
    assert.deepEqual(feedScrolls,[400], 'only a pinned feed that receives a new last message follows it');
  }
});

test('the background game disclosure keeps lobby, seats, phase prompts and AFK controls together', async () => {
  const ui = await frontend();
  const open = () => /data-do="toggle-game-area" aria-expanded="true" aria-controls="game-area-content"/.test(ui.html());
  assert.ok(open());
  assert.match(ui.html(), /type="button" id="toggle-game-area"/);
  assert.match(ui.html(), /data-do="match"/);
  let focused = 0;
  ui.field('toggle-game-area', {focus(options) { assert.equal(options.preventScroll,true); focused++; }});
  await ui.click({do:'toggle-game-area'});
  assert.equal(focused,1);
  assert.equal(open(),false);
  assert.match(ui.html(), /id="game-area-content" class="lg-game-content" hidden><\/div>/);
  assert.doesNotMatch(ui.html(), /data-do="match"|data-do="join-modal"|data-do="create"|class="seats"/);
  assert.match(ui.html(), /题目背景[\s\S]*?本题为交互题/);
  assert.match(ui.html(), /class="lg-statement|lg-statement-connected/);
  assert.match(ui.html(), /相关讨论/);
  assert.match(ui.html(), /推荐题目/);

  const view = gameView({myAfk:true,canSpeak:false});
  ui.putInRoom(view);
  await ui.click({sidebarToggle:'discussion'});
  const changed = json(ui.app.state.room);
  changed.game.phase = 'discussion';
  changed.messages.push({name:'玩家',seat:2,text:'折叠期间收到的发言',at:Date.now()});
  ui.setServerRoom(changed);
  await ui.app.refreshData();
  assert.equal(open(),false);
  assert.doesNotMatch(ui.html(), /class="seats"|class="room-status"|data-do="return"/);
  assert.match(ui.html(), /折叠期间收到的发言/);
  await ui.click({problemTab:'submit'});
  assert.match(ui.html(), /id="code-editor"/);
  await ui.click({problemTab:'description'});
  assert.equal(open(),false);
  await ui.click({do:'toggle-game-area'});
  assert.ok(open());
  assert.match(ui.html(), /class="seats"/);
  assert.match(ui.html(), /data-do="return">回到游戏/);
  assert.match(ui.html(), /class="room-status"/);
});
