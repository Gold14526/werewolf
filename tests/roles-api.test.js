import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { handleApi } from '../worker/api.js';
import { TestD1Database } from './d1-shim.js';

const config = {
  roles: { wolf: 1, wolfKing: 1, whiteWolfKing: 1, villager: 4, fool: 1, knight: 1 },
  victory: 'side', nightSeconds: 30, daySeconds: 60, sheriff: true,
};
const wolfRoles = new Set(['wolf', 'wolfKing', 'whiteWolfKing']);

async function setup(t, backend, { durable = false } = {}) {
  let now = 1_800_000_000_000;
  let origin = 'https://roles.example';
  let app, db, handler = handleApi;
  const directory = durable ? await mkdtemp(join(process.cwd(), 'moonwolf-api-')) : null;
  const databasePath = directory ? join(directory, 'game.sqlite') : ':memory:';
  async function open() {
    if (backend === 'node') {
      app = createApp({ databasePath, disableRateLimits: true, now: () => now });
      await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
      origin = `http://127.0.0.1:${app.server.address().port}`;
    } else db = new TestD1Database(databasePath);
  }
  async function close() { if (app) await app.close(); else db?.close(); }
  t.after(async () => {
    try { await close(); } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  });
  await open();
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
      if (durable) { await close(); await open(); }
      if (backend === 'cloud') handler = (await import('../worker/api.js?new-roles-function-instance')).handleApi;
    },
  };
}

async function makeGame(c, overrides = {}) {
  const people = [];
  const settings = { ...config, ...overrides };
  const count = Object.values(settings.roles).reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < count; i++) people.push(await c.session(`新角色${i + 1}`));
  const created = await c.request('/api/rooms', { token: people[0].token, body: { config: settings, visibility: 'public', name: '特殊角色房' } });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.match(created.data.room.code, /^\d{6}$/);
  assert.equal(created.data.room.config.sheriff, settings.sheriff);
  for (const [role, count] of Object.entries(settings.roles)) assert.equal(created.data.room.config.roles[role], count);
  const { code } = created.data.room;
  const listing = await c.request('/api/rooms', { token: people[1].token });
  assert.equal(listing.data.rooms.find(room => room.code === code).config.sheriff, settings.sheriff);
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
    assert.equal(people[0].room.game.phase, 'night');
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
    const revised = await c.request('/api/action', { token: wolves[0].token, body: { type: 'wolf', targetId: null } });
    assert.equal(revised.status, 200);
    assert.equal(revised.data.room.game.privateInfo.wolfVotes.find(ballot => ballot.playerId === wolves[0].player.id).targetId, null);
    c.setNow(people[0].room.game.deadline);
    const morning = (await c.request('/api/room', { token: target.token })).data.room.game;
    assert.equal(morning.phase, 'sheriff_signup');
    assert.equal((await c.request('/api/action', { token: wolves[0].token, body: { type: 'wolf', targetId: target.player.id } })).status, 400);
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

for (const backend of ['node', 'cloud']) {
  test(`${backend} room roster, playing seats and subsequent reloads agree when seating is shuffled`, async t => {
    const c = await setup(t, backend);
    const { people, code } = await makeGame(c, { shuffleSeats: true });
    const seats = people[0].room.players.map(p => [p.id, p.seat]);
    assert.equal(new Set(seats.map(([, seat]) => seat)).size, people.length);
    for (const person of people) {
      const visible = person.room.game.players.map(p => [p.id, p.seat]);
      assert.deepEqual(new Map(visible), new Map(seats));
    }
    await c.reloadHandler();
    c.setNow(people[0].room.game.deadline);
    const room = (await c.request('/api/room?code=' + code, { token: people[0].token })).data.room;
    assert.equal(room.game.phase, 'sheriff_signup');
    assert.deepEqual(room.players.map(p => [p.id, p.seat]), seats);
    assert.deepEqual(new Map(room.game.players.map(p => [p.id, p.seat])), new Map(seats));
  });

  test(`${backend} serializes competing seats across and within rooms`, async t => {
    const c = await setup(t, backend);
    const hostA = await c.session('甲房房主'), hostB = await c.session('乙房房主');
    const guest = await c.session('跨房玩家'), rival = await c.session('竞争座位');
    const post = (path, user, body) => c.request(path, { token: user.token, body });
    const create = async host => (await post('/api/rooms', host, { config })).data.room.code;
    const [a, b] = [await create(hostA), await create(hostB)];
    const seat = (user, code, n) => post('/api/seat?code=' + code, user, { seat: n });
    const join = (user, code) => post('/api/join', user, { code });
    const read = async (user, code) => (await c.request('/api/room?code=' + code, { token: user.token })).data.room;
    for (const code of [a, b]) {
      assert.equal((await join(guest, code)).status, 200);
      assert.equal((await seat(guest, code, null)).data.room.isSpectator, true);
    }
    const race = await Promise.all([seat(guest, a, 4), seat(guest, b, 4)]);
    assert.equal(race.filter(r => r.status === 200).length, 1);
    const [won, lost] = race[0].status === 200 ? [a, b] : [b, a];
    assert.equal((await read(guest, won)).players.find(p => p.id === guest.player.id).seat, 4);
    assert.equal((await read(guest, lost)).players.some(p => p.id === guest.player.id), false);
    assert.ok((await seat(guest, won, 1)).status >= 400);
    assert.equal((await seat(guest, won, 3)).data.room.players.find(p => p.id === guest.player.id).seat, 3);
    assert.equal((await join(rival, won)).status, 200);
    const sameSeat = await Promise.all([seat(rival, won, 4), seat(guest, won, 4)]);
    assert.equal(sameSeat.filter(r => r.status === 200).length, 1);
    const final = await read(guest, won);
    assert.equal(final.players.length, 3);
    assert.equal(new Set(final.players.map(p => p.seat)).size, 3);
  });

  test(`${backend} observers and eliminated participants may enter another game while original seats remain fixed`, async t => {
    const c = await setup(t, backend);
    const { people, code } = await makeGame(c);
    const outsider = await c.session('临时观众');
    const nextHost = await c.session('下一局房主');
    const next = (await c.request('/api/rooms', { token: nextHost.token, body: { config } })).data.room.code;
    const guest = people.find(p => p.role === 'villager');
    const living = people.find(p => p.role === 'knight');
    // Resolve an actual expulsion, so the public announcement and automatic
    // gallery membership are checked together in both adapters.
    c.editRoom(code, ({ game }) => {
      game.phase = 'vote';
      game.deadline = 1_800_000_030_000;
    });
    const ballot = await c.request('/api/action', { token: living.token, body: { type: 'vote', targetId: guest.player.id } });
    assert.equal(ballot.status, 200, ballot.data.error);
    c.setNow(ballot.data.room.game.deadline);
    const past = (await c.request('/api/room?code=' + code, { token: guest.token })).data.room;
    assert.equal(past.isSpectator, true);
    const firstSeat = past.players.find(p => p.id === guest.player.id).seat;
    assert.ok(past.game.log.some(event => event.text === firstSeat + ' 号玩家被放逐。'));
    assert.equal(past.messages.some(m => m.text.includes('观战席')), false);
    const entered = (await c.request('/api/join', { token: outsider.token, body: { code } })).data.room;
    assert.equal(entered.isSpectator, true);
    assert.equal(entered.messages.filter(m => m.text === '临时观众 加入了观战席').length, 1);
    for (const spectator of [guest, outsider]) {
      const joined = await c.request('/api/join', { token: spectator.token, body: { code: next } });
      assert.equal(joined.status, 200);
      assert.ok(joined.data.room.players.some(p => p.id === spectator.player.id));
      const old = (await c.request('/api/room?code=' + code, { token: spectator.token })).data.room;
      assert.equal(old.isSpectator, true);
      assert.equal(old.players.find(p => p.id === guest.player.id).seat, firstSeat);
    }
    for (const [route, body] of [['/api/join', { code: next }], ['/api/match', {}], ['/api/rooms', { config }]]) {
      const res = await c.request(route, { token: living.token, body });
      assert.ok([200, 400, 403].includes(res.status));
      if (res.status === 200) assert.equal(res.data.room.code, code, 'a repeated request can only preserve the current playing seat');
    }
    assert.ok((await c.request('/api/seat?code=' + code, { token: living.token, body: { seat: 1 } })).status >= 400);
    assert.equal((await c.request('/api/room', { token: nextHost.token })).data.room.players.length, 3);
  });
}

for (const backend of ['node', 'cloud']) {
  test(`${backend} keeps spectators read-only and preserves a dead player's outstanding last words across rooms`, async t => {
    const c = await setup(t, backend);
    const { people, code } = await makeGame(c);
    const observer = await c.session('旁观测试'), wolf = people.find(p => wolfRoles.has(p.role));
    const read = (user, roomCode) => c.request('/api/room?code=' + roomCode, { token: user.token });
    const post = (user, path, body = {}) => c.request('/api/' + path, { token: user.token, body });
    await post(wolf, 'chat', { text: '仅同伴可见', channel: 'wolf' });
    const watching = (await post(observer, 'join', { code })).data.room;
    assert.equal(watching.isSpectator, true);
    assert.equal(watching.players.length, people.length);
    assert.equal(watching.messages.filter(m => m.text === '旁观测试 加入了观战席').length, 1);
    assert.equal(watching.messages.some(m => m.text === '仅同伴可见'), false);
    assert.equal(watching.game.myRole, null);
    assert.deepEqual(watching.game.privateInfo, {});
    assert.equal(watching.game.players.some(p => p.role), false);
    assert.equal((await post(observer, 'chat', { text: '观众发言' })).status, 403);
    assert.equal((await post(observer, 'action', { type: 'wolf', targetId: null })).status, 403);
    assert.equal((await post(observer, 'action', { type: 'return' })).status, 403);
    assert.equal((await post(observer, 'leave')).status, 200);
    assert.equal((await read(observer, code)).status, 403);
    assert.equal((await read(wolf, code)).data.room.messages.at(-1).text, '旁观测试 离开了观战席');

    const originalSeat = watching.players.find(p => p.id === wolf.player.id).seat;
    c.editRoom(code, ({ game }) => {
      game.players.find(p => p.id === wolf.player.id).alive = false;
      game.phase = 'lastwords'; game.currentSpeakerId = wolf.player.id;
      game.lastWordsQueue = [wolf.player.id]; game.deadline = 1_800_000_120_000;
      game.inactivityDeadline = 1_800_000_060_000;
    });
    const afterDeath = (await read(wolf, code)).data.room;
    assert.equal(afterDeath.isSpectator, true);
    assert.equal(afterDeath.game.action.type, 'pass');
    assert.equal(afterDeath.game.canSpeak, true);
    assert.equal(afterDeath.game.players.find(p => p.id === wolf.player.id).alive, false);
    assert.deepEqual(afterDeath.game.privateInfo, {});
    assert.equal(afterDeath.messages.some(m => m.channel === 'wolf'), false);
    const second = (await post(wolf, 'rooms', { config })).data;
    assert.notEqual(second.room.code, code);
    assert.deepEqual(new Set(second.memberships.map(m => m.code)), new Set([code, second.room.code]));
    const spoken = await post(wolf, 'chat?code=' + code, { text: '我的遗言' });
    assert.equal(spoken.status, 200, spoken.data.error);
    assert.equal(spoken.data.room.messages.at(-1).seat, originalSeat);
    assert.equal((await post(wolf, 'action?code=' + code, { type: 'pass' })).status, 200);
    assert.equal((await post(wolf, 'action?code=' + code, { type: 'vote', targetId: null })).status, 403);
    await c.reloadHandler();
    assert.equal((await read(wolf, second.room.code)).data.room.isSpectator, false);
    assert.equal((await read(wolf, code)).data.room.isSpectator, true);
  });

  test(`${backend} upgrades an in-progress legacy room and persists real speaking activity independently of voting`, async t => {
    const c = await setup(t, backend);
    const { people, code } = await makeGame(c);
    const speaker = people[0], start = 1_800_000_000_000;
    c.editRoom(code, room => {
      for (const config of [room.config, room.game.config]) {
        config.nightSeconds = 75;
        delete config.otherNightSeconds;
        delete config.witchSelfSave;
        delete config.shuffleSeats;
      }
      room.game.phase = 'wolf';
      room.game.deadline = start + 75_000;
      delete room.game.night.windows;
    });
    const fetchRoom = () => c.request('/api/room', { token: speaker.token });
    const upgraded = (await fetchRoom()).data.room;
    assert.equal(upgraded.game.phase, 'night');
    for (const config of [upgraded.config, upgraded.game.config]) {
      assert.equal(config.nightSeconds, 75);
      assert.equal(config.otherNightSeconds, 30);
      assert.equal(config.witchSelfSave, 'first');
      assert.equal(config.shuffleSeats, false);
    }
    c.editRoom(code, ({ game }) => {
      game.phase = 'discussion';
      game.speechQueue = people.map(p => p.player.id);
      game.currentSpeakerId = speaker.player.id; game.deadline = start + 120_000;
      game.inactivityDeadline = start + 60_000;
    });
    c.setNow(start + 48_000);
    const typed = await c.request('/api/action', { token: speaker.token, body: { type: 'typing' } });
    assert.equal(typed.status, 200, typed.data.error);
    assert.equal(typed.data.room.game.inactivityDeadline, start + 108_000);
    c.setNow(start + 65_000);
    await c.reloadHandler();
    const current = (await fetchRoom()).data.room.game;
    assert.equal(current.currentSpeakerId, speaker.player.id);
    assert.equal(current.myAfk, false);
    c.setNow(start + 109_000);
    const inactive = (await fetchRoom()).data.room.game;
    assert.equal(inactive.myAfk, true);
    assert.notEqual(inactive.currentSpeakerId, speaker.player.id);
    const back = await c.request('/api/action', { token: speaker.token, body: { type: 'return' } });
    assert.equal(back.status, 200, back.data.error);
    assert.equal(back.data.room.game.myAfk, false);
  });
}

for (const backend of ['node', 'cloud']) {
  test(`${backend} freezes legacy chat seat numbers before moving seats and shuffling the roster`, async t => {
    const c = await setup(t, backend);
    const people = [];
    for (let i = 0; i < 9; i++) people.push(await c.session('座号测试' + i));
    const [host, later] = people;
    const post = (route, user, body) => c.request('/api/' + route, { token: user.token, body });
    const created = await post('rooms', host, { config: { ...config, shuffleSeats: true } });
    const { code } = created.data.room;
    const oldMessage = (player, text) => ({ playerId: player.player.id, name: player.player.name, channel: 'public', text, at: 1 });
    c.editRoom(code, room => {
      delete room.messageSeatsVersion;
      room.messages.push(oldMessage(host, '原一号发言'), oldMessage(later, '座号无法还原的发言'));
    });
    function checkTranscript(room) {
      assert.equal(room.messages.find(m => m.text === '原一号发言').seat, 1);
      assert.equal(room.messages.find(m => m.text === '座号无法还原的发言').seat, null);
    }
    const moved = await post('seat', host, { seat: 4 });
    assert.equal(moved.data.room.players.find(p => p.id === host.player.id).seat, 4);
    checkTranscript(moved.data.room);
    for (const person of people.slice(1)) {
      assert.equal((await post('join', person, { code })).status, 200);
      assert.equal((await post('ready', person, { ready: true })).status, 200);
    }
    const started = await post('start', host, {});
    assert.equal(started.status, 200, started.data.error);
    checkTranscript(started.data.room);
    c.editRoom(code, checkTranscript);
  });
}

for (const backend of ['node', 'cloud']) {
  test(`${backend} restores independent night revisions and results for duplicate roles`, async t => {
    const c = await setup(t, backend, { durable: true });
    const { people, code } = await makeGame(c, {
      roles: { guard: 2, wolf: 2, seer: 2, witch: 2, villager: 2 },
      sheriff: false, victory: 'all', nightSeconds: 60, otherNightSeconds: 30,
    });
    const ofRole = role => people.filter(p => p.role === role);
    const guards = ofRole('guard'), wolves = ofRole('wolf'), seers = ofRole('seer');
    const witches = ofRole('witch'), villagers = ofRole('villager');
    for (const group of [guards, wolves, seers, witches, villagers]) assert.equal(group.length, 2);
    async function read(person) {
      const res = await c.request('/api/room?code=' + code, { token: person.token });
      assert.equal(res.status, 200, res.data.error);
      return res.data.room.game;
    }
    async function act(person, target, choice) {
      const game = await read(person);
      assert.equal(game.action.type, person.role);
      const action = { type: person.role, targetId: target?.player.id ?? null, round: game.round, turnDeadline: game.action.deadline };
      if (choice) action.choice = choice;
      const res = await c.request('/api/action?code=' + code, { token: person.token, body: action });
      assert.equal(res.status, 200, res.data.error);
      assert.deepEqual(res.data.room.game.action.selected, { targetId: action.targetId, ...(choice ? { choice } : {}) });
      return res.data.room.game;
    }

    await Promise.all([act(guards[0], villagers[0]), act(guards[1], witches[0])]);
    const guard = await act(guards[0], seers[0]);
    assert.equal((await read(guards[1])).action.selected.targetId, witches[0].player.id);
    assert.equal((await read(villagers[0])).action, null);
    c.setNow(guard.action.deadline);

    await Promise.all([act(wolves[0], villagers[1]), act(wolves[1], villagers[0])]);
    const wolf = await act(wolves[0], villagers[0]);
    c.setNow(wolf.action.deadline);
    await Promise.all([act(seers[0], wolves[0]), act(seers[1], wolves[1])]);
    await act(seers[0], villagers[0]);
    await c.reloadHandler();
    const first = await read(seers[0]), second = await read(seers[1]);
    assert.equal(first.action.selected.targetId, villagers[0].player.id);
    assert.equal(second.action.selected.targetId, wolves[1].player.id);
    c.setNow(first.action.deadline);

    for (const witch of witches) assert.equal((await read(witch)).privateInfo.nightVictim.id, villagers[0].player.id);
    const seerResult = async () => {
      for (const [person, target, team] of [[seers[0], villagers[0], 'good'], [seers[1], wolves[1], 'wolf']]) {
        const view = await read(person);
        assert.deepEqual(view.privateInfo.results.map(r => [r.id, r.team]), [[target.player.id, team]]);
        assert.equal(view.privateInfo.potions, undefined);
      }
    };
    await seerResult();
    await Promise.all([act(witches[0], villagers[0], 'poison'), act(witches[1], null, 'skip')]);
    const [saving] = await Promise.all([act(witches[0], villagers[0], 'save'), act(witches[1], villagers[1], 'poison')]);
    c.setNow(saving.action.deadline);
    const dawn = await read(villagers[0]);
    assert.notEqual(dawn.phase, 'night');
    assert.equal(dawn.players.find(p => p.id === villagers[0].player.id).alive, true);
    assert.deepEqual(dawn.players.filter(p => !p.alive).map(p => p.id), [villagers[1].player.id]);
    assert.deepEqual(dawn.privateInfo, {});
    await c.reloadHandler();
    await seerResult();
    for (const [witch, potions] of [[witches[0], { save: false, poison: true }], [witches[1], { save: true, poison: false }]]) {
      const view = await read(witch);
      assert.deepEqual(view.privateInfo.potions, potions);
      assert.equal(view.privateInfo.results, undefined);
    }
  });
}
