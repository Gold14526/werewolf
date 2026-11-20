import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 60 * 60 * 1000;
const config = { roles: { wolf: 2, villager: 2, seer: 1, witch: 1, hunter: 0, guard: 0 }, victory: 'side', nightSeconds: 30, daySeconds: 60 };
const jsonClone = value => JSON.parse(JSON.stringify(value));
const cleanups = new WeakMap();

function onCleanup(t, callback) {
  if (!cleanups.has(t)) {
    const callbacks = [];
    cleanups.set(t, callbacks);
    t.after(async () => {
      const errors = [];
      for (const dispose of callbacks.reverse()) {
        try { await dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Persistence test cleanup failed');
    });
  }
  cleanups.get(t).push(callback);
}

async function databaseFile(t) {
  // Some sandboxed runners do not provide /tmp. Keep the fallback inside
  // the checked-out workspace, while ordinary runners use their temp root.
  const temporaryRoot = await stat(tmpdir()).then(info => info.isDirectory() ? tmpdir() : PROJECT, error => {
    if (error.code === 'ENOENT') return PROJECT;
    throw error;
  });
  const directory = await mkdtemp(path.join(temporaryRoot, 'moonwolf-persistence-'));
  onCleanup(t, () => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'game.sqlite');
}

function client(origin) {
  const request = async (route, { token, body } = {}) => {
    const response = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const session = async name => {
    const result = await request('/api/session', { body: { name } });
    assert.equal(result.status, 201, result.data.error);
    return result.data;
  };
  return { request, session };
}

async function startApp(t, databasePath, options = {}) {
  const app = createApp({ databasePath, disableRateLimits: true, ...options });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.close();
  };
  onCleanup(t, stop);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  return { app, stop, ...client(`http://127.0.0.1:${app.server.address().port}`) };
}

async function makeGame(context, visibility = 'private') {
  const users = [];
  for (let i = 0; i < 6; i++) users.push(await context.session(`持久玩家${i + 1}`));
  const created = await context.request('/api/rooms', {
    token: users[0].token, body: { config, visibility, name: '重启恢复测试房' },
  });
  assert.equal(created.status, 200, created.data.error);
  const code = created.data.room.code;
  for (const user of users.slice(1)) {
    assert.equal((await context.request('/api/join', { token: user.token, body: { code } })).status, 200);
    assert.equal((await context.request('/api/ready', { token: user.token, body: { ready: true } })).status, 200);
  }
  assert.equal((await context.request('/api/chat', { token: users[0].token, body: { text: '开局前已确认保存的消息' } })).status, 200);
  assert.equal((await context.request('/api/start', { token: users[0].token, body: {} })).status, 200);
  return { users, code };
}

test('SQLite restart restores an advanced game, hidden roles, sessions, messages and partial votes after two hours offline', async t => {
  const databasePath = await databaseFile(t);
  let now = 1_800_000_000_000;
  const original = await startApp(t, databasePath, { now: () => now });
  const { users, code } = await makeGame(original);
  const room = original.app.state.rooms.get(code);
  const game = room.game;
  const userFor = player => users.find(user => user.player.id === player.id);
  const wolves = game.players.filter(player => player.role === 'wolf').map(userFor);
  const seer = userFor(game.players.find(player => player.role === 'seer'));
  const witch = userFor(game.players.find(player => player.role === 'witch'));
  const villager = userFor(game.players.find(player => player.role === 'villager'));
  assert.equal(game.phase, 'wolf');
  assert.equal((await original.request('/api/chat', { token: wolves[0].token, body: { channel: 'wolf', text: '仅狼队可见的持久消息' } })).status, 200);
  for (const wolf of wolves) {
    assert.equal((await original.request('/api/action', { token: wolf.token, body: { type: 'wolf', targetId: villager.player.id } })).status, 200);
  }
  now = game.deadline;
  original.app.tick();
  assert.equal(game.phase, 'seer');
  assert.equal((await original.request('/api/action', { token: seer.token, body: { type: 'seer', targetId: wolves[0].player.id } })).status, 200);
  now = game.deadline;
  original.app.tick();
  assert.equal(game.phase, 'witch');
  assert.equal((await original.request('/api/action', { token: witch.token, body: { type: 'witch', choice: 'save', targetId: villager.player.id } })).status, 200);
  now = game.deadline;
  original.app.tick();
  assert.equal(game.phase, 'discussion');
  const speaker = users.find(user => user.player.id === game.currentSpeakerId);
  assert.equal((await original.request('/api/chat', { token: speaker.token, body: { text: '白天已确认保存的发言' } })).status, 200);
  while (game.phase === 'discussion') {
    const speaker = users.find(user => user.player.id === game.currentSpeakerId);
    assert.equal((await original.request('/api/action', { token: speaker.token, body: { type: 'pass' } })).status, 200);
  }
  assert.equal(game.phase, 'vote');
  assert.equal((await original.request('/api/action', { token: villager.token, body: { type: 'vote', targetId: wolves[0].player.id } })).status, 200);
  const beforeGame = jsonClone(game);
  const beforeMessages = jsonClone(room.messages);
  const beforeSeats = room.players.map(({ id, name, seat, ready }) => ({ id, name, seat, ready }));
  assert.equal(beforeGame.potions.save, false);
  assert.equal(beforeGame.investigations[seer.player.id][0].team, 'wolf');
  assert.equal(beforeGame.actions[villager.player.id].targetId, wolves[0].player.id);
  await original.stop();

  now += 2 * HOUR;
  const restored = await startApp(t, databasePath, { now: () => now });
  restored.app.tick();
  const recovered = restored.app.state.rooms.get(code);
  assert.ok(recovered, 'downtime must not delete the active room');
  assert.deepEqual(recovered.players.map(({ id, name, seat, ready }) => ({ id, name, seat, ready })), beforeSeats);
  assert.deepEqual(jsonClone(recovered.messages), beforeMessages);
  const afterGame = jsonClone(recovered.game);
  assert.ok(afterGame.deadline >= now + 30_000, 'restored phase must allow time for players to reconnect');
  assert.ok(afterGame.deadline <= now + 60_000, 'recovery must not create an unbounded phase timer');
  delete beforeGame.deadline;
  delete afterGame.deadline;
  assert.deepEqual(afterGame, beforeGame, 'roles, night outcomes, potions, seer results, queues and partial votes must survive');

  for (const user of users) {
    const authentication = await restored.request('/api/session', { token: user.token, body: {} });
    assert.equal(authentication.status, 200, authentication.data.error);
    assert.equal(authentication.data.player.id, user.player.id);
    assert.equal(authentication.data.token, user.token);
    const response = await restored.request('/api/room', { token: user.token });
    assert.equal(response.status, 200);
    assert.equal(response.data.room.code, code);
    const self = recovered.game.players.find(player => player.id === user.player.id);
    assert.equal(response.data.room.game.myRole, self.role);
    for (const player of response.data.room.game.players) {
      const actual = recovered.game.players.find(candidate => candidate.id === player.id);
      assert.equal(Object.hasOwn(player, 'role'), player.id === self.id || (self.role === 'wolf' && actual.role === 'wolf'));
    }
    assert.equal(Object.hasOwn(response.data.room.game, 'actions'), false);
    assert.equal(Object.hasOwn(response.data.room.game, 'night'), false);
    assert.equal(response.data.room.messages.some(message => message.text === '仅狼队可见的持久消息'), self.role === 'wolf');
    const storedSession = [...restored.app.state.sessions.values()].find(session => session.id === user.player.id);
    assert.equal(recovered.players.find(player => player.id === user.player.id).session, storedSession, 'room members must reference the live session object');
  }
  const seerView = (await restored.request('/api/room', { token: seer.token })).data.room.game;
  assert.deepEqual(seerView.privateInfo.results, beforeGame.investigations[seer.player.id]);
  assert.equal((await restored.request('/api/room', { token: villager.token })).data.room.game.submitted, true);
});

test('waiting room and original player tokens survive a three-day outage instead of expiring during downtime', async t => {
  const databasePath = await databaseFile(t);
  let now = 1_800_000_000_000;
  const original = await startApp(t, databasePath, { now: () => now });
  const host = await original.session('等待房主');
  const guest = await original.session('等待好友');
  const created = await original.request('/api/rooms', { token: host.token, body: { config } });
  const code = created.data.room.code;
  assert.equal((await original.request('/api/join', { token: guest.token, body: { code } })).status, 200);
  assert.equal((await original.request('/api/ready', { token: guest.token, body: { ready: true } })).status, 200);
  await original.stop();
  now += 72 * HOUR;
  const restored = await startApp(t, databasePath, { now: () => now });
  restored.app.tick();
  const response = await restored.request('/api/room', { token: guest.token });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.room.code, code);
  assert.equal(response.data.room.hostId, host.player.id);
  assert.equal(response.data.room.players.length, 2);
  assert.equal(response.data.room.players.find(player => player.id === guest.player.id).ready, true);
  assert.equal((await restored.request('/api/session', { token: host.token, body: {} })).status, 200);
});

async function startProcess(t, databasePath) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createApp } from './server/index.mjs';
    const app = createApp({ databasePath: process.env.TEST_DATABASE_PATH, disableRateLimits: true });
    app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: app.server.address().port })));
  `], { cwd: PROJECT, env: { ...process.env, TEST_DATABASE_PATH: databasePath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data.toString(); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  };
  onCleanup(t, stop);
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child server did not start: ${stderr}`)), 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Child server exited before startup: ${stderr}`)); });
    lines.on('line', line => {
      if (!line.startsWith('{')) return;
      try {
        const message = JSON.parse(line);
        if (Number.isInteger(message.port)) { clearTimeout(timeout); resolve(message.port); }
      } catch {}
    });
  });
  lines.close();
  return { stop, child, ...client(`http://127.0.0.1:${port}`) };
}

test('acknowledged game actions survive SIGKILL without a graceful-shutdown flush', { timeout: 20_000 }, async t => {
  const databasePath = await databaseFile(t);
  const original = await startProcess(t, databasePath);
  const { users, code } = await makeGame(original);
  const views = await Promise.all(users.map(async user => ({ user, room: (await original.request('/api/room', { token: user.token })).data.room })));
  const wolf = views.find(view => view.room.game.myRole === 'wolf').user;
  const good = views.find(view => view.room.game.myRole === 'villager').user;
  assert.equal((await original.request('/api/chat', { token: wolf.token, body: { channel: 'wolf', text: 'SIGKILL 前服务端确认的私聊' } })).status, 200);
  const acknowledged = await original.request('/api/action', { token: wolf.token, body: { type: 'wolf', targetId: good.player.id } });
  assert.equal(acknowledged.status, 200, acknowledged.data.error);
  assert.equal(acknowledged.data.room.game.submitted, true);
  await original.stop();
  assert.equal(original.child.signalCode, 'SIGKILL');

  const restarted = await startProcess(t, databasePath);
  const recovered = await restarted.request('/api/room', { token: wolf.token });
  assert.equal(recovered.status, 200, recovered.data.error);
  assert.equal(recovered.data.room.code, code);
  assert.equal(recovered.data.room.game.phase, 'wolf');
  assert.equal(recovered.data.room.game.submitted, true);
  assert.ok(recovered.data.room.game.privateInfo.wolfVotes.some(vote => vote.playerId === wolf.player.id && vote.targetId === good.player.id));
  assert.ok(recovered.data.room.messages.some(message => message.text === 'SIGKILL 前服务端确认的私聊'));
  const goodView = await restarted.request('/api/room', { token: good.token });
  assert.equal(goodView.status, 200);
  assert.equal(goodView.data.room.game.myRole, 'villager');
  assert.equal(goodView.data.room.messages.some(message => message.text === 'SIGKILL 前服务端确认的私聊'), false);
});

test('finished private history and standings persist and are not counted again after restart', async t => {
  const databasePath = await databaseFile(t);
  let now = 1_800_000_000_000;
  const original = await startApp(t, databasePath, { now: () => now });
  const { users, code } = await makeGame(original);
  const outsider = await original.session('局外玩家');
  const room = original.app.state.rooms.get(code);
  room.game.phase = 'finished';
  room.game.winner = 'good';
  room.game.deadline = null;
  original.app.tick();
  const expectedStats = (await original.request('/api/stats', { token: users[0].token })).data.standings;
  const expectedHistory = (await original.request('/api/history', { token: users[0].token })).data.history;
  assert.equal(expectedStats.length, 6);
  assert.ok(expectedStats.every(player => player.games === 1));
  await original.stop();
  now += 2 * HOUR;
  const restarted = await startApp(t, databasePath, { now: () => now });
  restarted.app.tick();
  restarted.app.tick();
  assert.deepEqual((await restarted.request('/api/stats', { token: users[0].token })).data.standings, expectedStats);
  assert.deepEqual((await restarted.request('/api/history', { token: users[0].token })).data.history, expectedHistory);
  assert.equal((await restarted.request(`/api/history/${code}`, { token: users[0].token })).status, 200);
  assert.equal((await restarted.request(`/api/history/${code}`, { token: outsider.token })).status, 404);
});

test('a database write failure never acknowledges a mutation and the failed process stays closed to writes', async t => {
  const databasePath = await databaseFile(t);
  const original = await startApp(t, databasePath);
  const user = await original.session('已经持久化的昵称');
  const failureDb = new DatabaseSync(databasePath);
  try {
    failureDb.exec("CREATE TRIGGER reject_state_update BEFORE UPDATE ON app_state BEGIN SELECT RAISE(FAIL, 'simulated disk failure'); END;");
    const rejected = await original.request('/api/session', { token: user.token, body: { name: '不应确认的新昵称' } });
    assert.equal(rejected.status, 503);
    assert.ok(rejected.data.error);
    failureDb.exec('DROP TRIGGER reject_state_update');
    assert.equal((await original.request('/api/session', { body: { name: '不能绕过失败状态' } })).status, 503);
    assert.equal((await original.request('/api/health')).status, 503);
  } finally {
    failureDb.close();
  }
  await original.stop();
  const restarted = await startApp(t, databasePath);
  const recovered = await restarted.request('/api/session', { token: user.token, body: {} });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.player.name, '已经持久化的昵称');
  assert.equal(restarted.app.state.sessions.size, 1);
});

test('an older process cannot overwrite a newer database owner with its stale in-memory snapshot', async t => {
  const databasePath = await databaseFile(t);
  const older = await startApp(t, databasePath);
  const first = await older.session('原进程玩家');
  const newer = await startApp(t, databasePath);
  const second = await newer.session('新进程玩家');
  const staleWrite = await older.request('/api/session', { body: { name: '旧快照覆盖尝试' } });
  assert.equal(staleWrite.status, 503);
  await older.stop();
  await newer.stop();
  const restarted = await startApp(t, databasePath);
  assert.equal((await restarted.request('/api/session', { token: first.token, body: {} })).status, 200);
  assert.equal((await restarted.request('/api/session', { token: second.token, body: {} })).status, 200);
  assert.deepEqual([...restarted.app.state.sessions.values()].map(session => session.name).sort(), ['原进程玩家', '新进程玩家'].sort());
});

test('the private database cannot be placed under web or exposed through a static-file symlink', async t => {
  const databasePath = await databaseFile(t);
  const uniqueName = `private-${path.basename(path.dirname(databasePath))}.sqlite`;
  const publicPath = path.join(PROJECT, 'web', uniqueName);
  assert.throws(() => createApp({ databasePath: publicPath }), /public web directory/);
  const alias = path.join(path.dirname(databasePath), 'web-alias');
  await symlink(path.join(PROJECT, 'web'), alias, 'dir');
  assert.throws(() => createApp({ databasePath: path.join(alias, uniqueName) }), /public web directory/);
  const running = await startApp(t, databasePath);
  await running.session('私密数据库玩家');
  await symlink(databasePath, publicPath, 'file');
  onCleanup(t, () => rm(publicPath, { force: true }));
  const response = await fetch(`http://127.0.0.1:${running.app.server.address().port}/${uniqueName}`);
  assert.equal(response.status, 404);
  await response.arrayBuffer();
});

test('an unreadable saved snapshot fails startup without replacing it with an empty game database', async t => {
  const databasePath = await databaseFile(t);
  const original = await startApp(t, databasePath);
  await original.session('不能被静默清空的玩家');
  await original.stop();
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare('UPDATE app_state SET payload = ? WHERE id = 1').run('{malformed-snapshot');
    const before = { ...db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get() };
    assert.throws(() => createApp({ databasePath }));
    assert.deepEqual({ ...db.prepare('SELECT revision, payload FROM app_state WHERE id = 1').get() }, before);
  } finally {
    db.close();
  }
});
