import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../worker/api.js';
import { loadState, withState } from '../worker/store.js';
import { TestD1Database } from './d1-shim.js';

const config = { roles: { wolf: 2, villager: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }, victory: 'side', nightSeconds: 30, daySeconds: 60 };

function setup(t, extraEnv = {}) {
  const DB = new TestD1Database();
  t.after(() => DB.close());
  const env = { DB, ...extraEnv };
  const origin = 'https://werewolf.example';
  async function request(route, { token, body, headers = {}, method, handler = handleApi } = {}) {
    const input = new Request(origin + route, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const response = await handler(input, env);
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  }
  async function session(name) {
    const result = await request('/api/session', { body: { name } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  function entities(kind) {
    return DB.sqlite.prepare('SELECT entity_key, data FROM moonwolf_entities WHERE kind = ?').all(kind).map(row => ({ key: row.entity_key, value: JSON.parse(row.data) }));
  }
  function editRoom(code, mutate) {
    const row = DB.sqlite.prepare("SELECT data FROM moonwolf_entities WHERE kind='rooms' AND entity_key=?").get(code);
    assert.ok(row, `room ${code} persisted`);
    const room = JSON.parse(row.data); mutate(room);
    DB.sqlite.prepare("UPDATE moonwolf_entities SET data=? WHERE kind='rooms' AND entity_key=?").run(JSON.stringify(room), code);
  }
  return { DB, env, origin, request, session, entities, editRoom };
}

async function users(context, count) {
  const all = [];
  for (let i = 0; i < count; i++) all.push(await context.session(`玩家${i + 1}`));
  return all;
}

async function makeGame(context, visibility = 'private') {
  const people = await users(context, 6);
  const created = await context.request('/api/rooms', { token: people[0].token, body: { name: '测试房间', config, visibility } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const code = created.data.room.code;
  for (const user of people.slice(1)) {
    assert.equal((await context.request('/api/join', { token: user.token, body: { code } })).status, 200);
    assert.equal((await context.request('/api/ready', { token: user.token, body: { ready: true } })).status, 200);
  }
  assert.equal((await context.request('/api/start', { token: people[0].token, body: {} })).status, 200);
  return { people, code };
}

test('cloud API stores sessions durably and a fresh Worker instance restores the same seat', async t => {
  const c = setup(t);
  const health = await c.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.equal(health.data.service, 'moonwolf');
  assert.equal(health.data.storage, 'd1');
  assert.equal((await c.request('/api/room')).status, 401);
  const player = await c.session('晨星');
  const created = await c.request('/api/rooms', { token: player.token, body: { config } });
  assert.equal(created.status, 200);
  const { handleApi: freshHandler } = await import('../worker/api.js?independent-worker');
  const restored = await c.request('/api/session', { token: player.token, body: {}, handler: freshHandler });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.token, player.token);
  assert.equal(restored.data.player.id, player.player.id);
  const room = await c.request('/api/room', { token: player.token, handler: freshHandler });
  assert.equal(room.data.room.code, created.data.room.code);
  assert.equal(room.data.room.players.length, 1);
  // Bearer credentials are hashed before storage, not retained as plaintext.
  const persisted = JSON.stringify(c.DB.sqlite.prepare('SELECT * FROM moonwolf_entities').all());
  assert.equal(persisted.includes(player.token), false);
});

test('cloud API matches twelve concurrent users into one full room without duplicate seats', async t => {
  const c = setup(t);
  const people = await users(c, 12);
  const matched = await Promise.all(people.map(user => c.request('/api/match', { token: user.token, body: {} })));
  for (const result of matched) assert.equal(result.status, 200, JSON.stringify(result.data));
  const codes = new Set(matched.map(result => result.data.room.code));
  assert.equal(codes.size, 1);
  const views = await Promise.all(people.map(user => c.request('/api/room', { token: user.token })));
  for (const { status, data } of views) {
    assert.equal(status, 200);
    assert.equal(data.room.players.length, 12);
    assert.equal(new Set(data.room.players.map(p => p.id)).size, 12);
    assert.equal(new Set(data.room.players.map(p => p.seat)).size, 12);
    assert.equal(data.room.config.roles.wolf, 4);
    assert.ok(data.room.game);
    assert.equal(Object.hasOwn(data.room.game, 'actions'), false);
    assert.equal(Object.hasOwn(data.room.game, 'night'), false);
    const roleCount = data.room.game.players.filter(p => Object.hasOwn(p, 'role')).length;
    assert.equal(roleCount, data.room.game.myRole === 'wolf' ? 4 : 1);
  }
});

test('cloud API automatically seats overflow observers and preserves one playing seat per player', async t => {
  const c = setup(t);
  const people = await users(c, 9);
  const roomA = (await c.request('/api/rooms', { token: people[0].token, body: { config } })).data.room;
  const roomB = (await c.request('/api/rooms', { token: people[1].token, body: { config } })).data.room;
  const samePlayer = await Promise.all([roomA.code, roomB.code].map(code => c.request('/api/join', { token: people[2].token, body: { code } })));
  assert.equal(samePlayer.filter(result => result.status === 200).length, 1);
  assert.equal(samePlayer.filter(result => result.status === 400).length, 1);
  const assigned = (await c.request('/api/room', { token: people[2].token })).data.room;
  const target = assigned.code;
  const admissions = await Promise.all(people.slice(3).map(user => c.request('/api/join', { token: user.token, body: { code: target } })));
  assert.ok(admissions.every(result => result.status === 200));
  assert.equal(admissions.filter(result => result.data.room.isSpectator).length, 2);
  const current = (await c.request('/api/room', { token: people[2].token })).data.room;
  assert.equal(current.players.length, 6);
  assert.equal(new Set(current.players.map(p => p.seat)).size, 6);
  const duplicate = await c.request('/api/join', { token: people[2].token, body: { code: target } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.room.players.length, 6);
});

test('cloud API delivers wolf messages privately and rejects unauthorized night actions', async t => {
  const c = setup(t);
  const { people, code } = await makeGame(c, 'public');
  const views = await Promise.all(people.map(async user => ({ user, room: (await c.request('/api/room', { token: user.token })).data.room })));
  const wolf = views.find(view => view.room.game.myRole === 'wolf').user;
  const good = views.find(view => view.room.game.myRole !== 'wolf').user;
  assert.equal(views[0].room.game.phase, 'night');
  assert.equal((await c.request('/api/chat', { token: good.token, body: { text: '窃听狼聊', channel: 'wolf' } })).status, 400);
  assert.equal((await c.request('/api/action', { token: good.token, body: { type: 'wolf', targetId: wolf.player.id } })).status, 400);
  assert.equal((await c.request('/api/chat', { token: wolf.token, body: { text: '仅狼队可见的秘密', channel: 'wolf' } })).status, 200);
  const goodView = (await c.request('/api/room', { token: good.token })).data.room;
  const wolfView = (await c.request('/api/room', { token: wolf.token })).data.room;
  assert.equal(JSON.stringify(goodView).includes('仅狼队可见的秘密'), false);
  assert.equal(JSON.stringify(wolfView).includes('仅狼队可见的秘密'), true);
  const outsider = await c.session('房外玩家');
  const observing = await c.request('/api/join', { token: outsider.token, body: { code } });
  assert.equal(observing.status, 200);
  assert.equal(observing.data.room.isSpectator, true);
  assert.ok(observing.data.room.game.players.every(player => !player.role));
});

test('cloud API records finished history once and keeps private replay restricted', async t => {
  const c = setup(t);
  const { people, code } = await makeGame(c);
  c.editRoom(code, room => { room.game.phase = 'finished'; room.game.winner = 'good'; room.game.deadline = null; });
  await c.request('/api/room', { token: people[0].token });
  await c.request('/api/room', { token: people[0].token });
  const history = (await c.request('/api/history', { token: people[0].token })).data.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].winner, 'good');
  const replay = (await c.request(`/api/history/${code}`, { token: people[0].token })).data.room;
  assert.ok(replay.game.players.every(p => p.role));
  assert.equal(Object.hasOwn(replay.game, 'actions'), false);
  const stats = (await c.request('/api/stats', { token: people[0].token })).data.standings;
  assert.equal(stats.length, 6);
  assert.ok(stats.every(p => p.games === 1));
  const outsider = await c.session('无关玩家');
  assert.deepEqual((await c.request('/api/history', { token: outsider.token })).data.history, []);
  assert.equal((await c.request(`/api/history/${code}`, { token: outsider.token })).status, 404);
});

test('cloud API only accepts same-origin or configured CORS requests', async t => {
  const c = setup(t, { ALLOWED_ORIGINS: 'https://alice.github.io' });
  const allowed = await c.request('/api/health', { headers: { Origin: 'https://alice.github.io' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://alice.github.io');
  assert.equal((await c.request('/api/health', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await c.request('/api/health', { headers: { Origin: c.origin } })).status, 200);
  const preflight = await c.request('/api/room', { method: 'OPTIONS', headers: { Origin: 'https://alice.github.io' } });
  assert.equal(preflight.status, 204);
});

test('cloud API advances persisted deadlines and lets outsiders read finished public games', async t => {
  let now = Date.now();
  const c = setup(t, { CLOCK: () => now });
  const { people, code } = await makeGame(c, 'public');
  const before = (await c.request('/api/room', { token: people[0].token })).data.room;
  let phase = before.game;
  for (const label of ['狼人行动', '预言家行动', '女巫行动']) {
    assert.equal(phase.phaseLabel, label);
    now = phase.deadline;
    phase = (await c.request('/api/room', { token: people[0].token })).data.room.game;
  }
  const advanced = (await c.request('/api/room', { token: people[0].token })).data.room;
  assert.equal(advanced.game.phase, 'discussion');
  assert.ok(advanced.game.deadline > Date.now());
  c.editRoom(code, room => { room.game.phase = 'finished'; room.game.winner = 'wolf'; room.game.deadline = null; });
  await c.request('/api/room', { token: people[0].token });
  const spectator = await c.session('观众');
  const replay = await c.request(`/api/history/${code}`, { token: spectator.token });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.room.game.myRole, null);
  assert.deepEqual(replay.data.room.game.privateInfo, {});
  assert.ok(replay.data.room.game.players.every(p => p.role));
});

test('D1 CAS retries concurrent transactions without lost or double-applied increments', async t => {
  const c = setup(t);
  let callbackCalls = 0;
  const results = await Promise.all(Array.from({ length: 12 }, () => withState(c.DB, state => {
    callbackCalls++;
    const count = (state.limits.get('cas-test')?.count ?? 0) + 1;
    state.limits.set('cas-test', { count });
    state.standings.set('cas-test', { games: count });
    return count;
  })));
  assert.deepEqual(results.sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.ok(callbackCalls > 12, 'concurrent snapshots exercised retry paths');
  const final = await loadState(c.DB);
  assert.equal(final.state.limits.get('cas-test').count, 12);
  assert.equal(final.state.standings.get('cas-test').games, 12);
  assert.equal(final.revision, 12);
});

test('stable room polling is read-only between heartbeat deadlines', async t => {
  const c = setup(t);
  const user = await c.session('心跳测试');
  await c.request('/api/rooms', { token: user.token, body: { config } });
  const before = c.DB.sqlite.prepare('SELECT revision FROM moonwolf_meta WHERE id=1').get().revision;
  for (let i = 0; i < 5; i++) assert.equal((await c.request('/api/room', { token: user.token })).status, 200);
  const after = c.DB.sqlite.prepare('SELECT revision FROM moonwolf_meta WHERE id=1').get().revision;
  assert.equal(after, before);
});

test('rejected action cannot mutate the authoritative game or inject private roles', async t => {
  const c = setup(t);
  const { people, code } = await makeGame(c);
  const views = await Promise.all(people.map(async user => ({ user, room: (await c.request('/api/room', { token: user.token })).data.room })));
  const unauthorized = views.find(view => view.room.game.myRole !== 'wolf').user;
  const before = c.entities('rooms').find(entry => entry.key === code).value.game;
  const response = await c.request('/api/action', { token: unauthorized.token, body: {
    type: 'wolf', targetId: people[0].player.id, role: 'wolf', winner: 'wolf', phase: 'finished',
  } });
  assert.equal(response.status, 400);
  const after = c.entities('rooms').find(entry => entry.key === code).value.game;
  assert.deepEqual(after, before);
  assert.equal(JSON.stringify(response.data).includes('audit'), false);
});
