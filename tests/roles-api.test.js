import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.mjs';
import { handleApi } from '../worker/api.js';
import { TestD1Database } from './d1-shim.js';

const config = {
  roles: { wolf: 1, wolfKing: 1, whiteWolfKing: 1, villager: 4, fool: 1, knight: 1 },
  victory: 'side', nightSeconds: 30, daySeconds: 60, sheriff: true,
};
const wolfRoles = new Set(['wolf', 'wolfKing', 'whiteWolfKing']);

async function setup(t, backend) {
  let now = 1_800_000_000_000;
  let origin = 'https://roles.example';
  let app, db, handler = handleApi;
  if (backend === 'node') {
    app = createApp({ databasePath: ':memory:', disableRateLimits: true, now: () => now });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${app.server.address().port}`;
    t.after(() => app.close());
  } else {
    db = new TestD1Database();
    t.after(() => db.close());
  }
  async function request(route, { token, body } = {}) {
    const input = new Request(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = app ? await fetch(input) : await handler(input, { DB: db, CLOCK: () => now });
    return { status: response.status, data: await response.json() };
  }
  async function session(name) {
    const response = await request('/api/session', { body: { name } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  function editRoom(code, mutate) {
    if (app) mutate(app.state.rooms.get(code));
    else {
      const room = JSON.parse(db.sqlite.prepare("SELECT data FROM moonwolf_entities WHERE kind='rooms' AND entity_key=?").get(code).data);
      mutate(room);
      db.sqlite.prepare("UPDATE moonwolf_entities SET data=? WHERE kind='rooms' AND entity_key=?").run(JSON.stringify(room), code);
    }
  }
  return {
    request, session, editRoom, setNow(value) { now = value; },
    async reloadHandler() {
      if (!app) handler = (await import('../worker/api.js?new-roles-function-instance')).handleApi;
    },
  };
}

async function makeGame(c) {
  const people = [];
  for (let i = 0; i < 9; i++) people.push(await c.session(`新角色${i + 1}`));
  const created = await c.request('/api/rooms', { token: people[0].token, body: { config, visibility: 'public', name: '特殊角色上警局' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.match(created.data.room.code, /^\d{6}$/);
  assert.equal(created.data.room.config.sheriff, true);
  for (const role of ['wolfKing', 'whiteWolfKing', 'fool', 'knight']) assert.equal(created.data.room.config.roles[role], 1);
  const { code } = created.data.room;
  const listing = await c.request('/api/rooms', { token: people[1].token });
  assert.equal(listing.data.rooms.find(room => room.code === code).config.sheriff, true);
  for (const person of people.slice(1)) {
    assert.equal((await c.request('/api/join', { token: person.token, body: { code } })).status, 200);
    assert.equal((await c.request('/api/ready', { token: person.token, body: { ready: true } })).status, 200);
  }
  assert.equal((await c.request('/api/start', { token: people[0].token, body: {} })).status, 200);
  const views = [];
  for (const person of people) {
    const result = await c.request('/api/room', { token: person.token });
    assert.equal(result.status, 200);
    views.push({ ...person, role: result.data.room.game.myRole, room: result.data.room });
  }
  return { people: views, code };
}

for (const backend of ['node', 'cloud']) {
  test(`${backend} API gives both wolf kings private wolf access and keeps all good roles out`, async t => {
    const c = await setup(t, backend);
    const { people, code } = await makeGame(c);
    const wolves = people.filter(person => wolfRoles.has(person.role));
    const good = people.filter(person => !wolfRoles.has(person.role));
    assert.equal(wolves.length, 3);
    assert.deepEqual(new Set(wolves.map(person => person.role)), wolfRoles);
    assert.equal(people[0].room.game.phase, 'wolf');
    const target = good.find(person => person.role === 'villager');
    const knight = good.find(person => person.role === 'knight');
    const whiteKing = wolves.find(person => person.role === 'whiteWolfKing');
    assert.equal((await c.request('/api/action', { token: knight.token, body: { type: 'duel', targetId: whiteKing.player.id } })).status, 400, 'knight cannot duel at night');
    assert.equal((await c.request('/api/action', { token: whiteKing.token, body: { type: 'explode', targetId: knight.player.id } })).status, 400, 'white wolf king cannot explode at night');
    for (const person of good) {
      assert.equal((await c.request('/api/chat', { token: person.token, body: { channel: 'wolf', text: '不应发送的消息' } })).status, 400);
      assert.equal((await c.request('/api/action', { token: person.token, body: { type: 'wolf', targetId: target.player.id } })).status, 400);
    }
    for (const person of wolves) {
      assert.equal((await c.request('/api/chat', { token: person.token, body: { channel: 'wolf', text: `${person.role} 的秘密消息` } })).status, 200);
      assert.equal((await c.request('/api/action', { token: person.token, body: { type: 'wolf', targetId: target.player.id } })).status, 200);
    }
    // A freshly imported cloud handler must recover the same roles, settings,
    // private chat and confirmed actions exclusively from durable room state.
    await c.reloadHandler();
    for (const person of people) {
      const restored = await c.request('/api/room', { token: person.token });
      assert.equal(restored.status, 200);
      const room = restored.data.room, game = room.game;
      assert.equal(room.code, code);
      assert.equal(room.config.sheriff, true);
      assert.equal(game.myRole, person.role);
      assert.equal(game.submitted, wolfRoles.has(person.role));
      assert.equal(room.messages.filter(message => message.channel === 'wolf').length, wolfRoles.has(person.role) ? 3 : 0);
      assert.equal(game.players.filter(player => player.role).length, wolfRoles.has(person.role) ? 3 : 1);
      for (const player of game.players.filter(player => player.role)) {
        assert.ok(player.id === person.player.id || wolfRoles.has(player.role));
      }
      assert.equal(Object.hasOwn(game, 'night'), false);
      assert.equal(Object.hasOwn(game, 'actions'), false);
    }
    assert.equal((await c.request('/api/action', { token: wolves[0].token, body: { type: 'wolf', targetId: target.player.id } })).status, 400);
    c.setNow(people[0].room.game.deadline);
    const morning = (await c.request('/api/room', { token: target.token })).data.room.game;
    assert.equal(morning.phase, 'sheriff_signup');
    assert.equal(morning.players.find(player => player.id === target.player.id).alive, true, 'first-night deaths stay hidden until the sheriff election finishes');
    const signedUp = await c.request('/api/action', { token: target.token, body: { type: 'sheriff_signup', choice: 'join' } });
    assert.equal(signedUp.status, 200);
    assert.equal(signedUp.data.room.game.submitted, true);
    await c.reloadHandler();
    const election = (await c.request('/api/room', { token: target.token })).data.room.game;
    assert.equal(election.phase, 'sheriff_signup');
    assert.equal(election.submitted, true, 'an acknowledged election enrollment survives a function replacement');
  });

  test(`${backend} API credits both wolf kings to the wolf team and persists expanded replay configuration`, async t => {
    const c = await setup(t, backend);
    const { people, code } = await makeGame(c);
    // Completion is injected to isolate API accounting from the engine's win rules.
    c.editRoom(code, room => { room.game.phase = 'finished'; room.game.winner = 'wolf'; room.game.deadline = null; });
    const standings = (await c.request('/api/stats', { token: people[0].token })).data.standings;
    assert.equal(standings.length, 9);
    for (const person of people) {
      const result = standings.find(entry => entry.id === person.player.id);
      assert.equal(result.games, 1);
      assert.equal(result.wins, wolfRoles.has(person.role) ? 1 : 0, `${person.role} belongs to its correct team`);
    }
    const replay = (await c.request(`/api/history/${code}`, { token: people[0].token })).data.room;
    assert.equal(replay.config.sheriff, true);
    assert.equal(replay.game.players.length, 9);
    assert.ok(replay.game.players.every(player => typeof player.role === 'string'));
    for (const role of ['wolfKing', 'whiteWolfKing', 'fool', 'knight']) assert.equal(replay.game.players.filter(player => player.role === role).length, 1);
    const repeated = (await c.request('/api/stats', { token: people[0].token })).data.standings;
    assert.ok(repeated.every(entry => entry.games === 1), 'repeated reads cannot duplicate wins');
  });
}
