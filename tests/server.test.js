import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';

const config = { roles: { wolf: 2, villager: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }, victory: 'side', nightSeconds: 30, daySeconds: 60 };
async function setup(t, options = {}) {
  const app = createApp({ disableRateLimits: true, ...options });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(route, { token, body, headers = {}, method } = {}) {
    const response = await fetch(origin + route, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  }
  const session = async name => {
    const result = await request('/api/session', { body: { name } });
    assert.equal(result.status, 201);
    return result.data;
  };
  return { app, request, session, origin };
}

async function makeGame(context, visibility = 'private') {
  const { request, session } = context;
  const users = await Promise.all(Array.from({ length: 6 }, (_, i) => session(`玩家${i + 1}`)));
  const created = await request('/api/rooms', { token: users[0].token, body: { name: '测试房间', config, visibility } });
  assert.equal(created.status, 200);
  const code = created.data.room.code;
  for (const user of users.slice(1)) {
    assert.equal((await request('/api/join', { token: user.token, body: { code } })).status, 200);
    assert.equal((await request('/api/ready', { token: user.token, body: { ready: true } })).status, 200);
  }
  assert.equal((await request('/api/start', { token: users[0].token, body: {} })).status, 200);
  return { users, code };
}

test('health, authentication, session restore and nickname changes preserve identity', async t => {
  const { request, session } = await setup(t);
  assert.deepEqual((await request('/api/health')).data, { ok: true, version: 1, service: 'moonwolf' });
  assert.equal((await request('/api/room')).status, 401);
  const user = await session('游侠');
  const restored = await request('/api/session', { token: user.token, body: { name: '月影' } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.token, user.token);
  assert.equal(restored.data.player.id, user.player.id);
  assert.equal(restored.data.player.name, '月影');
  assert.equal((await request('/api/session', { token: 'x'.repeat(43), body: { name: '新用户' } })).status, 401);
});

test('private rooms use six digits, stay off list, validate custom configs and preserve seat on duplicate join', async t => {
  const { request, session } = await setup(t);
  const host = await session('房主');
  const joiner = await session('访客');
  const invalid = await request('/api/rooms', { token: host.token, body: { config: { roles: { wolf: 10 } } } });
  assert.equal(invalid.status, 400);
  const created = await request('/api/rooms', { token: host.token, body: { config, name: '这是一个长度超过十六字符的自定义房间名称' } });
  assert.equal(created.status, 200);
  const { code } = created.data.room;
  assert.match(code, /^[1-9]\d{5}$/);
  assert.equal(created.data.room.players[0].ready, true);
  assert.deepEqual((await request('/api/rooms', { token: joiner.token })).data.rooms, []);
  assert.equal((await request('/api/join', { token: joiner.token, body: { code: '12345x' } })).status, 400);
  const joined = await request('/api/join', { token: joiner.token, body: { code } });
  assert.equal(joined.data.room.players.length, 2);
  const duplicate = await request('/api/join', { token: joiner.token, body: { code } });
  assert.equal(duplicate.data.room.players.length, 2);
  assert.equal((await request('/api/rooms', { token: joiner.token, body: { config } })).status, 400);
  assert.equal((await request('/api/start', { token: joiner.token, body: {} })).status, 403);
  assert.equal((await request('/api/start', { token: host.token, body: {} })).status, 400);
  assert.equal((await request('/api/leave', { token: host.token, body: {} })).status, 200);
  const remaining = await request('/api/room', { token: joiner.token });
  assert.equal(remaining.data.room.hostId, joiner.player.id);
  assert.equal(remaining.data.room.players[0].ready, true);
});

test('twelve-player matching shares room, automatically starts, and reveals only authorized roles', async t => {
  const { request, session, app } = await setup(t);
  const users = [];
  let code;
  for (let i = 0; i < 12; i++) {
    const user = await session(`匹配${i}`); users.push(user);
    const matched = await request('/api/match', { token: user.token, body: {} });
    assert.equal(matched.status, 200);
    code ??= matched.data.room.code;
    assert.equal(matched.data.room.code, code);
    assert.equal(matched.data.room.players.length, i + 1);
    assert.equal(matched.data.room.config.roles.wolf, 4);
    if (i < 11) assert.equal(matched.data.room.game, null);
    else assert.notEqual(matched.data.room.game, null);
  }
  const game = app.state.rooms.get(code).game;
  for (const user of users) {
    const { data } = await request('/api/room', { token: user.token });
    const self = game.players.find(p => p.id === user.player.id);
    assert.equal(data.room.game.myRole, self.role);
    for (const player of data.room.game.players) {
      const actual = game.players.find(p => p.id === player.id);
      assert.equal(Object.hasOwn(player, 'role'), player.id === user.player.id || (self.role === 'wolf' && actual.role === 'wolf'));
    }
    assert.equal(Object.hasOwn(data.room.game, 'actions'), false);
    assert.equal(Object.hasOwn(data.room.game, 'night'), false);
    assert.equal(JSON.stringify(data).includes(user.token), false);
  }
  assert.equal((await request('/api/leave', { token: users[0].token, body: {} })).status, 400);
  assert.equal((await request('/api/session', { token: users[0].token, body: { name: '改名' } })).status, 400);
  const restored = await request('/api/session', { token: users[0].token, body: { name: users[0].player.name } });
  assert.equal(restored.data.player.id, users[0].player.id);
  assert.equal((await request('/api/room', { token: users[0].token })).data.room.code, code);
});

test('night actions and wolf chat are authorized and privately delivered', async t => {
  const context = await setup(t);
  const { users, code } = await makeGame(context, 'public');
  const { request, app } = context;
  const game = app.state.rooms.get(code).game;
  assert.equal(game.phase, 'wolf');
  const wolf = users.find(u => game.players.find(p => p.id === u.player.id).role === 'wolf');
  const good = users.find(u => game.players.find(p => p.id === u.player.id).role !== 'wolf');
  assert.equal((await request('/api/action', { token: good.token, body: { type: 'wolf', targetId: wolf.player.id } })).status, 400);
  assert.equal((await request('/api/chat', { token: good.token, body: { channel: 'wolf', text: '偷看' } })).status, 400);
  assert.equal((await request('/api/chat', { token: wolf.token, body: { channel: 'wolf', text: '狼队秘密' } })).status, 200);
  assert.equal((await request('/api/chat', { token: good.token, body: { text: '公开消息' } })).status, 400);
  const goodView = (await request('/api/room', { token: good.token })).data.room;
  const wolfView = (await request('/api/room', { token: wolf.token })).data.room;
  assert.equal(goodView.messages.some(m => m.text === '狼队秘密'), false);
  assert.equal(wolfView.messages.some(m => m.text === '狼队秘密'), true);
  assert.equal((await request('/api/action', { token: wolf.token, body: { type: 'wolf', targetId: 'not-a-player' } })).status, 400);
});

test('finished histories and standings are recorded once, private history stays private', async t => {
  const context = await setup(t);
  const { app, request, session } = context;
  const { users, code } = await makeGame(context);
  const room = app.state.rooms.get(code);
  room.game.phase = 'finished'; room.game.winner = 'good';
  app.tick(); app.tick();
  const history = (await request('/api/history', { token: users[0].token })).data.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].winner, 'good');
  const replay = (await request(`/api/history/${code}`, { token: users[0].token })).data.room;
  assert.equal(replay.game.players.every(p => typeof p.role === 'string'), true);
  assert.equal(Object.hasOwn(replay.game, 'actions'), false);
  const stats = (await request('/api/stats', { token: users[0].token })).data.standings;
  assert.equal(stats.length, 6);
  assert.equal(stats.every(s => s.games === 1), true);
  assert.equal(stats.filter(s => s.wins === 1).length, 4);
  const outsider = await session('旁观者');
  assert.deepEqual((await request('/api/history', { token: outsider.token })).data.history, []);
  assert.equal((await request(`/api/history/${code}`, { token: outsider.token })).status, 404);
  assert.equal((await request('/api/leave', { token: users[0].token, body: {} })).status, 200);
  assert.equal((await request(`/api/history/${code}`, { token: users[0].token })).status, 200);
});

test('public history is viewable by nonparticipants without claiming an identity', async t => {
  const context = await setup(t);
  const { app, request, session } = context;
  const { code } = await makeGame(context, 'public');
  const room = app.state.rooms.get(code);
  room.game.phase = 'finished'; room.game.winner = 'wolf'; app.tick();
  const spectator = await session('观众');
  const replay = await request(`/api/history/${code}`, { token: spectator.token });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.room.game.myRole, null);
  assert.deepEqual(replay.data.room.game.privateInfo, {});
  assert.equal(replay.data.room.game.players.every(p => p.role), true);
});

test('CORS uses explicit origins; sessions and source files are not public', async t => {
  const { request } = await setup(t, { allowedOrigins: 'https://alice.github.io' });
  const allowed = await request('/api/health', { headers: { Origin: 'https://alice.github.io' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://alice.github.io');
  assert.equal((await request('/api/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const preflight = await request('/api/room', { method: 'OPTIONS', headers: { Origin: 'https://alice.github.io' } });
  assert.equal(preflight.status, 204);
  assert.equal((await request('/server/index.mjs')).status, 404);
  assert.equal((await request('/.env')).status, 404);
});

test('disconnected waiting players are removed and empty rooms close', async t => {
  let now = Date.now();
  const { request, session, app } = await setup(t, { now: () => now });
  const user = await session('临时访客');
  const { data } = await request('/api/rooms', { token: user.token, body: { config } });
  assert.equal(app.state.rooms.has(data.room.code), true);
  now += 121000; app.tick();
  assert.equal(app.state.rooms.has(data.room.code), false);
  assert.equal((await request('/api/room', { token: user.token })).data.room, null);
});
