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
  return { app, elements, calls, click, field, submit };
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

test('room creation submits selected new roles and the sheriff checkbox and reset clears it', async () => {
  const ui = await frontend();
  ui.app.createModal();
  for (const name of ['狼王', '白狼王', '愚者', '骑士']) assert.match(ui.elements.get('#modal-root').innerHTML, new RegExp(`增加${name}`));
  assert.match(ui.elements.get('#modal-root').innerHTML, /type="checkbox" id="sheriff-enabled"/);
  assert.match(ui.elements.get('#modal-root').innerHTML, /<option value="75" selected>75 秒<\/option>/);
  for (const [role, delta] of [['wolf', -1], ['wolfKing', 1], ['villager', -1], ['fool', 1]]) await ui.click({ count: role, delta: String(delta) });
  ui.field('#other-night-seconds', { value: '40' }); ui.field('#witch-self-save', { value: 'none' });
  ui.field('#shuffle-seats', { checked: true }); ui.field('#sheriff-enabled', { checked: true });
  ui.field('#victory', { value: 'side' }); ui.field('#night-seconds', { value: '75' }); ui.field('#day-seconds', { value: '90' });
  ui.field('#room-name', { value: '角色测试' }); ui.field('#visibility', { value: 'private' });
  await ui.submit('create-form');
  const posted = ui.calls.find(c => c.path === '/api/rooms' && c.body)?.body;
  assert.equal(posted.config.sheriff, true);
  assert.equal(posted.config.shuffleSeats, true);
  assert.equal(posted.config.witchSelfSave, 'none');
  assert.equal(posted.config.otherNightSeconds, 40);
  assert.equal(posted.config.victory, 'side');
  assert.equal(posted.config.nightSeconds, 75);
  assert.equal(posted.config.roles.wolfKing, 1);
  assert.equal(posted.config.roles.fool, 1);
  assert.equal(Object.values(posted.config.roles).reduce((a, b) => a + b, 0), 12);
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
    putInRoom(ui.app, gameView({ myRole: role, sheriffId: 'me', players: [
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
