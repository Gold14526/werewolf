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
  '\n;globalThis.frontend={state,render,roomView,refreshData,waitForConnect:()=>connectPromise};';
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
    fetch: async (path, options = {}) => {
      calls.push({ path, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
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
    click, field, edit, submit, putInRoom, html: () => elements.get('#app').innerHTML,
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

test('a valid avatar selects a vote without sending it; confirmation sends exactly that target', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  assert.match(ui.html(), /<button[^>]*data-target="target"/);
  assert.doesNotMatch(ui.html(), /data-target="(?:me|dead|outside)"/);
  const before = ui.calls.length;
  await ui.click({ target: 'target' });
  assert.equal(ui.app.state.target, 'target');
  assert.equal(ui.calls.length, before);
  assert.equal(actions(ui).length, 0);
  await ui.click({ action: 'confirm' });
  assert.deepEqual(actions(ui).map(call => call.body), [{ type: 'vote', targetId: 'target' }]);
});

test('self, dead and noncandidate avatar clicks cannot replace an eligible voting target', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView({ phase: 'sheriff_vote', phaseLabel: '警长投票',
    action: { type: 'sheriff_vote', targets: [{ id: 'target', name: '目标玩家', seat: 2 }] } }));
  for (const id of ['me', 'dead', 'outside', 'missing']) {
    await ui.click({ target: id });
    assert.equal(ui.app.state.target, null, id + ' must not be selectable');
  }
  await ui.click({ target: 'target' });
  for (const id of ['me', 'dead', 'outside']) {
    await ui.click({ target: id });
    assert.equal(ui.app.state.target, 'target', 'invalid target must not replace the valid selection');
  }
  assert.equal(actions(ui).length, 0);
  await ui.click({ action: 'confirm' });
  assert.deepEqual(actions(ui).at(-1).body, { type: 'sheriff_vote', targetId: 'target' });
});

test('submitted, nonactionable and replay views cannot select or submit another vote', async () => {
  for (const overrides of [{ submitted: true }, { actionable: false }]) {
    const ui = await frontend();
    ui.putInRoom(gameView(overrides));
    await ui.click({ target: 'target' });
    await ui.click({ action: 'confirm' });
    assert.equal(ui.app.state.target, null);
    assert.equal(actions(ui).length, 0);
  }
  const ui = await frontend();
  ui.putInRoom(gameView());
  ui.app.state.replay = json(ui.app.state.room);
  ui.app.render();
  await ui.click({ target: 'target' });
  await ui.click({ action: 'confirm' });
  assert.equal(ui.app.state.target, null);
  assert.equal(actions(ui).length, 0);
});

test('a room poll invalidating the selected target prevents a stale vote from being posted', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView());
  await ui.click({ target: 'target' });
  const updated = json(ui.app.state.room);
  updated.game.action.targets = [];
  updated.game.players.find(player => player.id === 'target').alive = false;
  ui.setServerRoom(updated);
  await ui.app.refreshData();
  await ui.click({ action: 'confirm' });
  assert.equal(actions(ui).length, 0);
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
  assert.equal(actions(ui).length, 0);
});

test('night action controls and wolf chat exist only in 提交文件; code area stays independent', async () => {
  const ui = await frontend();
  ui.putInRoom(gameView({ phase: 'wolf', phaseLabel: '狼人行动', myRole: 'wolfKing', canWolfChat: true,
    action: { type: 'wolf', targets: [{ id: 'target', name: '目标玩家', seat: 2 }] } }));
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
  assert.deepEqual(actions(ui).at(-1).body, { type: 'wolf', targetId: 'target' });
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
  assert.deepEqual(actions(ui).map(call => call.body), [{ type: 'pass' }]);
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
