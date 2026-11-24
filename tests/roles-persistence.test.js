import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresStore } from '../neon/store.mjs';
import { STANDARD_CONFIG, createGame, act, advance, viewGame, isWolfRole } from '../web/engine.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = 1_800_000_000_000;
const CODE = '456789';
const NEW_CONFIG = {
  roles: { wolf: 1, wolfKing: 1, whiteWolfKing: 1, villager: 3, seer: 1, witch: 1, fool: 1, knight: 1 },
  victory: 'side', sheriff: true, nightSeconds: 30, daySeconds: 60,
};

// A real on-disk PostgreSQL JSONB store, using one leased PGlite connection.
// These tests exercise restarts and data semantics, not Neon availability or
// concurrent connections' lock scheduling.
function poolFor(database) {
  let available = Promise.resolve();
  return {
    async connect() {
      const previous = available;
      let releaseLease;
      available = new Promise(resolve => { releaseLease = resolve; });
      await previous;
      let released = false;
      return {
        async query(sql, parameters) {
          assert.equal(released, false);
          if (parameters !== undefined) return database.query(sql, parameters);
          return (await database.exec(sql)).at(-1) ?? { rows: [] };
        },
        release() {
          assert.equal(released, false);
          released = true;
          releaseLease();
        },
      };
    },
  };
}

async function diskStore(t) {
  const temporaryRoot = await stat(tmpdir()).then(info => info.isDirectory() ? tmpdir() : PROJECT, error => {
    if (error.code === 'ENOENT') return PROJECT;
    throw error;
  });
  const directory = await mkdtemp(path.join(temporaryRoot, 'moonwolf-roles-pg-'));
  const location = path.join(directory, 'postgres');
  let database = await PGlite.create(location);
  let now = START;
  let store = createPostgresStore(poolFor(database), { clock: () => now });
  t.after(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    async save(game) {
      now = Math.max(now, game.deadline - 1000);
      await store.withState(state => state.rooms.set(CODE, {
        code: CODE, name: '扩展角色重启验收', config: structuredClone(game.config),
        players: game.players.map(({ id, name, seat }) => ({ id, name, seat })),
        messages: [], game: structuredClone(game), lastActive: now,
      }));
    },
    async reopen(pause = 72 * 3_600_000) {
      await database.close();
      now += pause;
      database = await PGlite.create(location);
      store = createPostgresStore(poolFor(database), { clock: () => now });
      return store.withState(state => structuredClone(state.rooms.get(CODE).game));
    },
    get now() { return now; },
  };
}

function game(config = NEW_CONFIG) {
  const count = Object.values(config.roles).reduce((a, b) => a + b, 0);
  return createGame(Array.from({ length: count }, (_, i) => ({ id: `persist-${i + 1}`, name: `持久${i + 1}`, seat: i + 1 })), config, { now: START, random: () => 0.999 });
}
const rolePlayer = (g, role) => g.players.find(p => p.role === role);
const submit = (g, id, action) => act(g, id, action, Math.min(g.deadline, g.inactivityDeadline ?? Infinity) - 1);
const plain = object => JSON.parse(JSON.stringify(object));
function withoutDeadline(g) { const result = plain(g); delete result.deadline; return result; }

function finishNight(g, victim = null) {
  let stages = 0;
  while (g.phase === 'night') {
    assert.ok(stages++ < 5, 'night must leave its fixed stages');
    for (const p of g.players) {
      const view = viewGame(g, p.id);
      if (!view.actionable || view.submitted) continue;
      const phase = view.action.type;
      submit(g, p.id, {
        type: phase,
        targetId: phase === 'wolf' ? victim : null,
        ...(phase === 'witch' ? { choice: 'skip' } : {}),
      });
    }
    advance(g, g.deadline);
  }
}
function enroll(g, ids) {
  assert.equal(g.phase, 'sheriff_signup');
  for (const p of g.players) {
    if (g.phase !== 'sheriff_signup') break;
    if (viewGame(g, p.id).actionable) submit(g, p.id, { type: 'sheriff_signup', choice: ids.includes(p.id) ? 'join' : 'skip' });
  }
}
function finishCandidateSpeeches(g) {
  let speeches = 0;
  while (g.phase === 'sheriff_speech') {
    assert.ok(speeches++ < g.players.length * 2);
    submit(g, g.currentSpeakerId, { type: 'pass' });
  }
}
function beginDiscussion(g) {
  let steps = 0;
  while (['lastwords', 'sheriff_direction'].includes(g.phase)) {
    assert.ok(steps++ < g.players.length + 2);
    if (g.phase === 'lastwords') submit(g, g.currentSpeakerId, { type: 'pass' });
    else {
      const sheriff = g.players.find(p => viewGame(g, p.id).actionable);
      submit(g, sheriff.id, { type: 'sheriff_direction', choice: 'left' });
    }
  }
  assert.equal(g.phase, 'discussion');
}
function finishDiscussion(g) {
  beginDiscussion(g);
  let speeches = 0;
  while (g.phase === 'discussion') {
    assert.ok(speeches++ < g.players.length + 1);
    submit(g, g.currentSpeakerId, { type: 'pass' });
  }
  assert.equal(g.phase, 'vote');
}

test('Postgres reopen preserves partial sheriff signup and hidden first-night deaths', async t => {
  const store = await diskStore(t);
  const g = game();
  const victim = rolePlayer(g, 'villager');
  finishNight(g, victim.id);
  assert.equal(g.phase, 'sheriff_signup');
  const candidate = rolePlayer(g, 'knight');
  submit(g, candidate.id, { type: 'sheriff_signup', choice: 'join' });
  const before = plain(g);
  await store.save(g);
  const recovered = await store.reopen();
  assert.deepEqual(withoutDeadline(recovered), withoutDeadline(before));
  assert.ok(recovered.deadline >= store.now + 30_000);
  assert.equal(viewGame(recovered, candidate.id).submitted, true);
  assert.throws(() => submit(recovered, candidate.id, { type: 'sheriff_signup', choice: 'join' }), /已经|提交/);
  for (const p of recovered.players) {
    const view = viewGame(recovered, p.id);
    assert.equal(view.players.find(other => other.id === victim.id).alive, true, 'night death must remain unannounced while electing sheriff');
    assert.equal(Object.hasOwn(view, 'night'), false);
    assert.equal(Object.hasOwn(view, 'actions'), false);
    assert.equal(view.players.filter(other => other.role).length, isWolfRole(p.role) ? 3 : 1);
  }
  enroll(recovered, [candidate.id]);
  finishCandidateSpeeches(recovered);
  assert.equal(viewGame(recovered, candidate.id).sheriffId, candidate.id);
  assert.equal(recovered.players.find(p => p.id === victim.id).alive, false);
  beginDiscussion(recovered);
  assert.equal(viewGame(recovered, candidate.id).sheriffId, candidate.id);
});

test('Postgres reopen keeps acknowledged sheriff ballots and accepts changes through the restored voting deadline', async t => {
  const store = await diskStore(t);
  const g = game();
  finishNight(g);
  const candidates = [rolePlayer(g, 'knight'), rolePlayer(g, 'seer')];
  enroll(g, candidates.map(p => p.id));
  finishCandidateSpeeches(g);
  assert.equal(g.phase, 'sheriff_vote');
  const voter = g.players.find(p => viewGame(g, p.id).actionable);
  submit(g, voter.id, { type: 'sheriff_vote', targetId: candidates[0].id });
  await store.save(g);
  const recovered = await store.reopen();
  assert.deepEqual(withoutDeadline(recovered), withoutDeadline(g));
  assert.equal(viewGame(recovered, voter.id).submitted, true);
  assert.equal(viewGame(recovered, voter.id).myVoteTargetId, candidates[0].id);
  submit(recovered, voter.id, { type: 'sheriff_vote', targetId: candidates[1].id });
  assert.equal(viewGame(recovered, voter.id).myVoteTargetId, candidates[1].id);
  for (const p of recovered.players) {
    if (recovered.phase !== 'sheriff_vote') break;
    if (viewGame(recovered, p.id).actionable) submit(recovered, p.id, { type: 'sheriff_vote', targetId: candidates[0].id });
  }
  advance(recovered, recovered.deadline);
  assert.equal(viewGame(recovered, voter.id).sheriffId, candidates[0].id);
  beginDiscussion(recovered);
  assert.equal(recovered.speechQueue.at(-1), candidates[0].id, 'restored sheriff still speaks last');
});

test('Postgres reopen retains the badge, used knight duel and revealed fool restrictions', async t => {
  const store = await diskStore(t);
  const g = game();
  const knight = rolePlayer(g, 'knight'), fool = rolePlayer(g, 'fool'), sheriff = rolePlayer(g, 'villager');
  finishNight(g);
  enroll(g, [sheriff.id]);
  finishCandidateSpeeches(g);
  beginDiscussion(g);
  submit(g, knight.id, { type: 'duel', targetId: rolePlayer(g, 'wolf').id });
  while (g.phase === 'lastwords') submit(g, g.currentSpeakerId, { type: 'pass' });
  finishNight(g);
  finishDiscussion(g);
  for (const p of g.players) {
    if (g.phase !== 'vote') break;
    if (viewGame(g, p.id).actionable) submit(g, p.id, { type: 'vote', targetId: p.id === fool.id ? null : fool.id });
  }
  advance(g, g.deadline);
  assert.equal(g.players.find(p => p.id === fool.id).alive, true);
  assert.equal(viewGame(g, sheriff.id).players.find(p => p.id === fool.id).role, 'fool');
  await store.save(g);
  const recovered = await store.reopen();
  assert.deepEqual(withoutDeadline(recovered), withoutDeadline(g));
  finishNight(recovered);
  beginDiscussion(recovered);
  assert.equal(viewGame(recovered, knight.id).canDuel, false);
  assert.equal(viewGame(recovered, sheriff.id).sheriffId, sheriff.id);
  assert.throws(() => submit(recovered, knight.id, { type: 'duel', targetId: rolePlayer(recovered, 'whiteWolfKing').id }));
  finishDiscussion(recovered);
  assert.equal(viewGame(recovered, fool.id).actionable, false, 'fool must not regain voting after restart');
  assert.equal(viewGame(recovered, sheriff.id).action.targets.some(p => p.id === fool.id), false, 'revealed fool remains ineligible for exile');
});

test('Postgres reopens a pre-expansion snapshot without requiring sheriff or new role fields', async t => {
  const store = await diskStore(t);
  const g = game(STANDARD_CONFIG);
  const oldKeys = new Set(['config', 'phase', 'round', 'deadline', 'winner', 'players', 'log', 'audit', 'actions', 'night', 'previousGuard', 'potions', 'investigations', 'pendingHunters', 'hunterUsed', 'resume', 'currentSpeakerId', 'speechQueue', 'lastWordsQueue', 'runoff', 'voteTargets', 'eventSequence']);
  for (const key of Object.keys(g)) if (!oldKeys.has(key)) delete g[key];
  g.phase = 'guard';
  g.deadline = START + g.config.nightSeconds * 1000;
  g.night = { victim: null, guard: null, poison: null, saved: false };
  g.round = 2;
  g.previousGuard = rolePlayer(g, 'villager').id;
  g.potions = { save: false, poison: true };
  for (const field of ['otherNightSeconds', 'witchSelfSave', 'shuffleSeats', 'sheriff']) delete g.config[field];
  for (const role of ['wolfKing', 'whiteWolfKing', 'fool', 'knight']) delete g.config.roles[role];
  for (const p of g.players) {
    for (const key of Object.keys(p)) if (!['id', 'name', 'seat', 'role', 'alive'].includes(key)) delete p[key];
  }
  await store.save(g);
  const recovered = await store.reopen();
  advance(recovered, store.now);
  assert.equal(recovered.phase, 'night');
  assert.equal(recovered.config.otherNightSeconds, 30);
  const witch = rolePlayer(recovered, 'witch');
  assert.deepEqual(viewGame(recovered, witch.id).privateInfo.potions, { save: false, poison: true });
  assert.equal(viewGame(recovered, rolePlayer(recovered, 'wolf').id).action.type, 'wolf');
  assert.equal(viewGame(recovered, rolePlayer(recovered, 'guard').id).actionable, false, 'elapsed guard time exceeds the new 30-second window');
  finishNight(recovered);
  beginDiscussion(recovered);
  assert.equal(viewGame(recovered, recovered.players[0].id).sheriffId, null);
  finishDiscussion(recovered);
  assert.ok(recovered.players.every(p => viewGame(recovered, p.id).actionable));
});

test('Postgres reopens two witches’ revised decisions and debits each final potion once', async t => {
  const store = await diskStore(t);
  const g = game({ roles: { wolf: 1, villager: 3, witch: 2 }, victory: 'all' });
  const wolf = rolePlayer(g, 'wolf');
  const [first, second] = g.players.filter(p => p.role === 'witch');
  const [attacked, poisoned] = g.players.filter(p => p.role === 'villager');
  submit(g, wolf.id, { type: 'wolf', targetId: attacked.id });
  advance(g, g.deadline);
  submit(g, first.id, { type: 'witch', choice: 'save', targetId: attacked.id });
  submit(g, first.id, { type: 'witch', choice: 'poison', targetId: poisoned.id });
  submit(g, second.id, { type: 'witch', choice: 'save', targetId: attacked.id });
  await store.save(g);
  const recovered = await store.reopen();
  assert.deepEqual(withoutDeadline(recovered), withoutDeadline(g));
  assert.equal(viewGame(recovered, first.id).actionable, true);
  assert.equal(viewGame(recovered, second.id).actionable, true);
  assert.deepEqual(viewGame(recovered, first.id).privateInfo.potions, { save: true, poison: true });
  advance(recovered, recovered.deadline);
  assert.equal(recovered.players.find(p => p.id === attacked.id).alive, true);
  assert.equal(recovered.players.find(p => p.id === poisoned.id).alive, false);
  assert.deepEqual(viewGame(recovered, first.id).privateInfo.potions, { save: true, poison: false });
  assert.deepEqual(viewGame(recovered, second.id).privateInfo.potions, { save: false, poison: true });
  assert.equal(Object.hasOwn(viewGame(recovered, attacked.id).privateInfo, 'potions'), false);
});
