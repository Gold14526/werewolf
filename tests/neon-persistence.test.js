import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresStore } from '../neon/store.mjs';
import { handleApi } from '../worker/api.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3_600_000;
const config = { roles: { wolf: 2, villager: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }, victory: 'side', nightSeconds: 30, daySeconds: 60 };

/**
 * PGlite executes PostgreSQL SQL and transactions, including persisted JSONB.
 * Its one connection is leased until release(), like a pg Pool with max: 1.
 * Parallel callers below verify API/transaction behavior; they do not establish
 * cross-connection PostgreSQL row-lock behavior or Neon infrastructure uptime.
 */
function testPool(database) {
  let available = Promise.resolve();
  const pool = { fault: null, queries: [] };
  pool.connect = async () => {
    const previous = available;
    let releaseLease;
    available = new Promise(resolve => { releaseLease = resolve; });
    await previous;
    let released = false;
    return {
      async query(text, parameters) {
        assert.equal(released, false, 'queries must use a leased connection');
        pool.queries.push(text);
        const failure = pool.fault?.(text, parameters);
        if (failure) throw failure;
        if (parameters !== undefined) return database.query(text, parameters);
        const results = await database.exec(text);
        return results.at(-1) ?? { rows: [] };
      },
      release() {
        assert.equal(released, false, 'each connection must be released exactly once');
        released = true;
        releaseLease();
      },
    };
  };
  pool.query = async (text, parameters) => {
    const client = await pool.connect();
    try { return await client.query(text, parameters); }
    finally { client.release(); }
  };
  return pool;
}

async function setup(t, { persistent = false } = {}) {
  let now = 1_800_000_000_000;
  let directory;
  if (persistent) {
    const temporaryRoot = await stat(tmpdir()).then(info => info.isDirectory() ? tmpdir() : PROJECT, error => {
      if (error.code === 'ENOENT') return PROJECT;
      throw error;
    });
    directory = await mkdtemp(path.join(temporaryRoot, 'moonwolf-neon-'));
  }
  let database = await PGlite.create(directory ? path.join(directory, 'postgres') : undefined);
  let pool = testPool(database);
  let store = createPostgresStore(pool, { clock: () => now });
  const env = { STATE_STORE: store, CLOCK: () => now, ALLOWED_ORIGINS: 'https://gold14526.github.io' };
  t.after(async () => {
    await database.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  async function request(route, { token, body, headers = {}, customStore } = {}) {
    const response = await handleApi(new Request('https://function.example' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), customStore ? { ...env, STATE_STORE: customStore } : env);
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  async function session(name) {
    const result = await request('/api/session', { body: { name } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  return {
    request, session, env,
    get pool() { return pool; },
    get store() { return store; },
    get now() { return now; },
    set now(value) { now = value; },
    async snapshot() {
      return store.withState(state => structuredClone(state), { now });
    },
    async restart() {
      assert.ok(directory, 'restart requires a persistent database');
      await database.close();
      database = await PGlite.create(path.join(directory, 'postgres'));
      pool = testPool(database);
      store = createPostgresStore(pool, { clock: () => now });
      env.STATE_STORE = store;
    },
  };
}

async function makeGame(context) {
  const people = [];
  for (let i = 0; i < 6; i++) people.push(await context.session(`持久玩家${i + 1}`));
  const created = await context.request('/api/rooms', { token: people[0].token, body: { config, visibility: 'private' } });
  assert.equal(created.status, 200, created.data.error);
  const code = created.data.room.code;
  for (const person of people.slice(1)) {
    assert.equal((await context.request('/api/join', { token: person.token, body: { code } })).status, 200);
    assert.equal((await context.request('/api/ready', { token: person.token, body: { ready: true } })).status, 200);
  }
  assert.equal((await context.request('/api/start', { token: people[0].token, body: {} })).status, 200);
  return { people, code };
}

test('Postgres disk reopen keeps partial night actions, private chat and original identities after three days without requests', async t => {
  const c = await setup(t, { persistent: true });
  const { people, code } = await makeGame(c);
  const before = (await c.snapshot()).rooms.get(code);
  const wolf = people.find(person => before.game.players.some(p => p.id === person.player.id && p.role === 'wolf'));
  const target = before.game.players.find(p => p.role === 'villager');
  assert.equal((await c.request('/api/action', { token: wolf.token, body: { type: 'wolf', targetId: target.id } })).status, 200);
  assert.equal((await c.request('/api/chat', { token: wolf.token, body: { channel: 'wolf', text: '重启后仍须保密的狼聊' } })).status, 200);
  const saved = (await c.snapshot()).rooms.get(code);
  c.now += 72 * HOUR;
  await c.restart();

  // The first real API request invokes cleanup; storage must recover before it.
  const restored = await c.request('/api/room', { token: wolf.token });
  assert.equal(restored.status, 200, restored.data.error);
  assert.equal(restored.data.room.code, code);
  const recovered = (await c.snapshot()).rooms.get(code);
  assert.deepEqual(recovered.players, saved.players);
  assert.deepEqual(recovered.messages, saved.messages);
  assert.ok(recovered.game.deadline >= c.now + 30_000);
  const savedGame = structuredClone(saved.game), restoredGame = structuredClone(recovered.game);
  delete savedGame.deadline;
  delete restoredGame.deadline;
  assert.deepEqual(restoredGame, savedGame, 'roles and submitted hidden actions must survive the database reopen');

  for (const person of people) {
    const authentication = await c.request('/api/session', { token: person.token, body: {} });
    assert.equal(authentication.status, 200, authentication.data.error);
    assert.equal(authentication.data.player.id, person.player.id);
    assert.equal(authentication.data.token, person.token);
    const room = (await c.request('/api/room', { token: person.token })).data.room;
    const role = saved.game.players.find(p => p.id === person.player.id).role;
    assert.equal(room.game.myRole, role);
    assert.equal(Object.hasOwn(room.game, 'actions'), false);
    assert.equal(Object.hasOwn(room.game, 'night'), false);
    assert.equal(Object.hasOwn(room.game, 'audit'), false);
    assert.equal(room.game.players.filter(p => Object.hasOwn(p, 'role')).length, role === 'wolf' ? 2 : 1);
    assert.equal(room.messages.some(m => m.text === '重启后仍须保密的狼聊'), role === 'wolf');
  }
  const rows = await c.pool.query('SELECT data FROM moonwolf_pg_entities');
  for (const person of people) assert.equal(JSON.stringify(rows.rows).includes(person.token), false);
});

test('Postgres idle recovery preserves waiting seats and runs once across fresh adapters', async t => {
  const c = await setup(t);
  const host = await c.session('等待房主'), guest = await c.session('等待好友');
  const created = await c.request('/api/rooms', { token: host.token, body: { config } });
  const code = created.data.room.code;
  assert.equal((await c.request('/api/join', { token: guest.token, body: { code } })).status, 200);
  assert.equal((await c.request('/api/ready', { token: guest.token, body: { ready: true } })).status, 200);
  c.now += 72 * HOUR;
  const fresh = createPostgresStore(c.pool, { clock: () => c.now });
  assert.equal((await c.request('/api/health', { customStore: fresh })).status, 200);
  const result = await c.request('/api/room', { token: guest.token, customStore: fresh });
  assert.equal(result.status, 200, result.data.error);
  assert.equal(result.data.room.code, code);
  assert.equal(result.data.room.hostId, host.player.id);
  assert.equal(result.data.room.players.length, 2);
  assert.equal(result.data.room.players.find(p => p.id === guest.player.id).ready, true);
  const recovered = await c.snapshot();
  const second = createPostgresStore(c.pool, { clock: () => c.now });
  const unchanged = await second.withState(state => structuredClone(state));
  assert.deepEqual(unchanged, recovered, 'a new function instance must not apply the same downtime twice');
});

test('Postgres function replacement preserves a running phase timer and normal requests still advance it', async t => {
  const c = await setup(t);
  const { people, code } = await makeGame(c);
  const deadline = (await c.snapshot()).rooms.get(code).game.deadline;
  c.now += 10_000;
  const fresh = createPostgresStore(c.pool, { clock: () => c.now });
  const continuing = await c.request('/api/room', { token: people[0].token, customStore: fresh });
  assert.equal(continuing.status, 200, continuing.data.error);
  assert.equal(continuing.data.room.game.phase, 'wolf');
  assert.equal(continuing.data.room.game.deadline, deadline, 'ordinary cold starts must not repeatedly extend a phase');
  c.now = deadline;
  const advanced = await c.request('/api/room', { token: people[0].token, customStore: fresh });
  assert.equal(advanced.status, 200, advanced.data.error);
  assert.equal(advanced.data.room.game.phase, 'seer');
  assert.ok(advanced.data.room.game.deadline > c.now);
});

test('Postgres recovery gives stale players two minutes to return, then normal cleanup resumes', async t => {
  const c = await setup(t);
  const host = await c.session('回归房主'), guest = await c.session('离线玩家');
  const abandoned = await c.session('离线房主'), observer = await c.session('大厅玩家');
  const roomA = (await c.request('/api/rooms', { token: host.token, body: { config } })).data.room;
  assert.equal((await c.request('/api/join', { token: guest.token, body: { code: roomA.code } })).status, 200);
  const roomB = (await c.request('/api/rooms', { token: abandoned.token, body: { config } })).data.room;
  // Simulate a snapshot taken before normal cleanup got its next chance to run.
  // Shifting timestamps by downtime alone would still leave these records old.
  await c.store.withState(state => {
    for (const session of state.sessions.values()) {
      if (session.id !== observer.player.id) session.lastSeen = c.now - 25 * HOUR;
    }
    for (const room of state.rooms.values()) room.lastActive = c.now - 31 * 60_000;
  });
  c.now += 72 * HOUR;
  const resumedAt = c.now;
  assert.equal((await c.request('/api/room', { token: observer.token })).status, 200);
  const recovered = await c.snapshot();
  assert.equal(recovered.rooms.get(roomA.code).players.length, 2);
  assert.ok(recovered.rooms.has(roomB.code));
  assert.equal(recovered.sessions.size, 4);

  // Stay active in less-than-one-minute steps to avoid triggering another pause.
  for (const elapsed of [40_000, 80_000, 119_000]) {
    c.now = resumedAt + elapsed;
    assert.equal((await c.request('/api/room', { token: observer.token })).status, 200);
  }
  const reconnected = await c.request('/api/session', { token: host.token, body: {} });
  assert.equal(reconnected.status, 200, reconnected.data.error);
  assert.equal(reconnected.data.player.id, host.player.id);
  assert.equal((await c.request('/api/room', { token: host.token })).data.room.players.length, 2);

  c.now = resumedAt + 120_001;
  assert.equal((await c.request('/api/room', { token: observer.token })).status, 200);
  const cleaned = await c.snapshot();
  assert.deepEqual(cleaned.rooms.get(roomA.code).players.map(p => p.id), [host.player.id]);
  assert.equal(cleaned.rooms.has(roomB.code), false);
  assert.equal(cleaned.sessions.size, 2, 'unreturned expired sessions must be removed when the grace ends');
  assert.equal((await c.request('/api/session', { token: guest.token, body: {} })).status, 401);
});

test('Postgres concurrent API callers fill one standard twelve-player game with unique seats', async t => {
  const c = await setup(t);
  const people = [];
  for (let i = 0; i < 12; i++) people.push(await c.session(`匹配玩家${i + 1}`));
  const alternate = createPostgresStore(c.pool, { clock: () => c.now });
  const joined = await Promise.all(people.map((person, index) => c.request('/api/match', {
    token: person.token, body: {}, customStore: index % 2 ? alternate : c.store,
  })));
  assert.ok(joined.every(result => result.status === 200), JSON.stringify(joined.map(result => result.data.error)));
  assert.equal(new Set(joined.map(result => result.data.room.code)).size, 1);
  const room = (await c.request('/api/room', { token: people[0].token })).data.room;
  assert.equal(room.players.length, 12);
  assert.equal(new Set(room.players.map(p => p.id)).size, 12);
  assert.equal(new Set(room.players.map(p => p.seat)).size, 12);
  assert.equal(room.config.roles.wolf, 4);
  assert.ok(room.game);
  assert.equal(Object.hasOwn(room.game, 'actions'), false);
});

test('Postgres callback failure rolls back all mutations and releases the connection', async t => {
  const c = await setup(t);
  const person = await c.session('事务玩家');
  const before = await c.snapshot();
  await assert.rejects(c.store.withState(state => {
    state.sessions.clear();
    state.standings.set('partial-write', { id: 'partial-write', games: 99 });
    throw Object.assign(new Error('invalid action'), { status: 400 });
  }), /invalid action/);
  assert.deepEqual(await c.snapshot(), before);
  const response = await c.request('/api/session', { token: person.token, body: {} });
  assert.equal(response.status, 200, response.data.error);
});

test('Postgres full-capacity login failures do not restart recovery grace forever', async t => {
  const c = await setup(t);
  await c.session('仍活跃玩家');
  await c.store.withState(state => {
    for (let i = 0; i < 499; i++) {
      state.sessions.set(`old-${i}`, {
        id: `old-player-${i}`, name: `旧玩家${i}`, roomCode: null,
        createdAt: c.now - 24 * HOUR, lastSeen: c.now - 24 * HOUR + 60_000,
      });
    }
  });
  c.now += 72 * HOUR;
  const resumedAt = c.now;
  // Do not call snapshot()/withState() between retries: only the failing login
  // requests themselves may persist recovery and its activity heartbeat.
  for (const elapsed of [0, 30_000, 60_000, 90_000]) {
    c.now = resumedAt + elapsed;
    const result = await c.request('/api/session', { body: { name: '新加入玩家' } });
    assert.equal(result.status, 503, 'capacity remains full during the original reconnect grace');
    const persisted = await c.pool.query("SELECT data FROM moonwolf_pg_entities WHERE kind = 'sessions' AND entity_key = 'old-0'");
    assert.equal(persisted.rows[0].data.recoveryUntil, resumedAt + 120_000, 'rejected logins must not extend the grace repeatedly');
    const metadata = await c.pool.query('SELECT last_seen_ms FROM moonwolf_pg_meta WHERE id = 1');
    assert.equal(Number(metadata.rows[0].last_seen_ms), c.now, 'rejected requests must still record server activity');
  }
  c.now = resumedAt + 120_001;
  const admitted = await c.request('/api/session', { body: { name: '成功加入玩家' } });
  assert.equal(admitted.status, 201, admitted.data.error);
  const after = await c.snapshot();
  assert.equal(after.sessions.size, 2, 'expired old sessions are reclaimed after the single grace period');
  assert.ok([...after.sessions.values()].some(session => session.id === admitted.data.player.id));
});

test('Postgres failed callback persists only the recovery baseline and preserves its original error', async t => {
  const c = await setup(t);
  const person = await c.session('恢复事务玩家');
  const room = (await c.request('/api/rooms', { token: person.token, body: { config } })).data.room;
  const before = await c.snapshot();
  const downtime = 72 * HOUR;
  c.now += downtime;
  const businessError = Object.assign(new Error('rejected operation after recovery'), { status: 409 });
  await assert.rejects(c.store.withState(state => {
    [...state.sessions.values()][0].name = '不得保存的改名';
    state.sessions.clear();
    state.rooms.get(room.code).players.length = 0;
    state.rooms.delete(room.code);
    state.standings.set('injected', { id: 'injected', name: '不得保存', games: 1, wins: 1, winRate: 100 });
    throw businessError;
  }), error => error === businessError);
  const expected = structuredClone(before);
  for (const session of expected.sessions.values()) {
    session.lastSeen += downtime;
    session.recoveryUntil = c.now + 120_000;
  }
  for (const saved of expected.rooms.values()) {
    saved.lastActive += downtime;
    saved.recoveryUntil = c.now + 120_000;
  }
  assert.deepEqual(await c.snapshot(), expected, 'failed business mutations must not contaminate the committed recovery baseline');

  // If even that baseline cannot commit, report the database failure rather
  // than returning the earlier business error as though recovery succeeded.
  c.now += downtime;
  c.pool.fault = text => /^COMMIT\b/i.test(text.trim()) ? new Error('commit unavailable') : null;
  await assert.rejects(c.store.withState(() => { throw businessError; }), /commit unavailable/);
  c.pool.fault = null;
  const persisted = await c.pool.query("SELECT data FROM moonwolf_pg_entities WHERE kind = 'rooms' AND entity_key = $1", [room.code]);
  assert.deepEqual(persisted.rows[0].data, expected.rooms.get(room.code), 'failed commit must retain the previously durable recovery baseline');
});

test('Postgres write failure never acknowledges or partly stores an action, and hides database details', async t => {
  const c = await setup(t);
  const person = await c.session('提交玩家');
  const before = await c.snapshot();
  let injected = false;
  c.pool.fault = text => {
    if (!injected && /^COMMIT\b/i.test(text.trim())) {
      injected = true;
      return new Error('password=PRIVATE_DATABASE_SECRET postgres://private-host failed commit');
    }
  };
  const result = await c.request('/api/rooms', { token: person.token, body: { config } });
  c.pool.fault = null;
  assert.equal(injected, true, 'the failure must occur after entity writes and before commit');
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result.data).includes('PRIVATE_DATABASE_SECRET'), false);
  assert.equal(JSON.stringify(result.data).includes('private-host'), false);
  assert.deepEqual(await c.snapshot(), before, 'a rejected commit must preserve the prior room and session state');
  assert.equal((await c.request('/api/rooms', { token: person.token, body: { config } })).status, 200);
});

test('Postgres API rejects forbidden night actions without changing persisted game state', async t => {
  const c = await setup(t);
  const { people, code } = await makeGame(c);
  const before = (await c.snapshot()).rooms.get(code).game;
  const innocent = people.find(person => before.players.some(p => p.id === person.player.id && p.role !== 'wolf'));
  const response = await c.request('/api/action', { token: innocent.token, body: {
    type: 'wolf', targetId: people[0].player.id, role: 'wolf', phase: 'finished', winner: 'wolf',
  } });
  assert.equal(response.status, 400);
  assert.deepEqual((await c.snapshot()).rooms.get(code).game, before);
});

test('Postgres malformed state or missing metadata fails closed instead of resetting existing rooms', async t => {
  const c = await setup(t);
  const person = await c.session('完整性玩家');
  const created = await c.request('/api/rooms', { token: person.token, body: { config } });
  const code = created.data.room.code;
  const savedRoom = (await c.snapshot()).rooms.get(code);
  const corrupt = { code, privateMarker: 'DO_NOT_RETURN_CORRUPT_STATE' };
  await c.pool.query("UPDATE moonwolf_pg_entities SET data = $1::jsonb WHERE kind = 'rooms' AND entity_key = $2", [JSON.stringify(corrupt), code]);
  const response = await c.request('/api/room', { token: person.token });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.data).includes('DO_NOT_RETURN_CORRUPT_STATE'), false);
  const persisted = await c.pool.query("SELECT data FROM moonwolf_pg_entities WHERE kind = 'rooms' AND entity_key = $1", [code]);
  assert.deepEqual(persisted.rows[0].data, corrupt, 'corrupted data must remain available for operator recovery');
  await c.pool.query("UPDATE moonwolf_pg_entities SET data = $1::jsonb WHERE kind = 'rooms' AND entity_key = $2", [JSON.stringify(savedRoom), code]);
  await c.pool.query('DELETE FROM moonwolf_pg_meta WHERE id = 1');
  const replacement = createPostgresStore(c.pool, { clock: () => c.now });
  assert.equal((await c.request('/api/health', { customStore: replacement })).status, 503);
  assert.deepEqual((await c.pool.query('SELECT * FROM moonwolf_pg_meta')).rows, [], 'initialization must not reset the recovery clock when entities remain');
  assert.deepEqual((await c.pool.query("SELECT data FROM moonwolf_pg_entities WHERE kind = 'rooms' AND entity_key = $1", [code])).rows[0].data, savedRoom);
});

test('Postgres health reports durable storage and connection failures never fall back to memory', async t => {
  const c = await setup(t);
  const health = await c.request('/api/health', { headers: { Origin: 'https://gold14526.github.io' } });
  assert.equal(health.status, 200, health.data.error);
  assert.equal(health.data.storage, 'postgres');
  assert.equal(health.headers.get('Access-Control-Allow-Origin'), 'https://gold14526.github.io');
  const failed = createPostgresStore({ connect: async () => { throw new Error('postgres://SECRET@unavailable/db'); } });
  for (const [route, body] of [['/api/health', undefined], ['/api/session', { name: '未保存玩家' }]]) {
    const response = await c.request(route, { body, customStore: failed });
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(response.data).includes('SECRET'), false);
    assert.equal(Object.hasOwn(response.data, 'token'), false);
  }
});
