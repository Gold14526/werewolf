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

for (const legacy of [true, false]) {
  test(`Postgres restores ${legacy ? 'previously revealed' : 'unrevealed'} sheriff-shooter without reviving or revealing a seat`, async t => {
    const store = await diskStore(t);
    const g = game({ ...NEW_CONFIG, roles: { wolfKing: 2, whiteWolfKing: 2, seer: 4, hunter: 1 }, victory: 'all' });
    const hunter = rolePlayer(g, 'hunter'), heir = rolePlayer(g, 'seer');
    finishNight(g, hunter.id);
    enroll(g, [hunter.id]);
    assert.equal(g.phase, 'hunter');
    if (legacy) {
      // The preceding engine removed and revealed the shooter on entry to this phase.
      hunter.alive = false;
      hunter.revealed = true;
      g.sheriffId = null;
    }
    await store.save(g);
    const recovered = await store.reopen();
    const visibleHunter = () => viewGame(recovered, null).players.find(p => p.id === hunter.id);
    assert.equal(visibleHunter().alive, !legacy);
    assert.equal(visibleHunter().publicRole, legacy ? 'hunter' : undefined);
    assert.equal(viewGame(recovered, hunter.id).actionable, true);
    assert.equal(viewGame(recovered, heir.id).actionable, false);
    assert.equal(viewGame(recovered, null).phase, legacy ? 'hunter' : 'resolution');
    assert.equal(viewGame(recovered, hunter.id).phase, 'hunter');
    if (legacy) submit(recovered, hunter.id, { type: 'hunter', targetId: null });
    else advance(recovered, recovered.deadline);
    assert.equal(recovered.phase, 'sheriff_transfer');
    assert.equal(visibleHunter().alive, !legacy);
    assert.equal(visibleHunter().publicRole, legacy ? 'hunter' : undefined);
    assert.equal(recovered.winner, null);
    submit(recovered, hunter.id, { type: 'sheriff_transfer', targetId: heir.id });
    assert.equal(recovered.sheriffId, heir.id);
    assert.equal(visibleHunter().alive, false);
    assert.equal(visibleHunter().publicRole, legacy ? 'hunter' : undefined);
    assert.deepEqual(recovered.hunterUsed, [hunter.id]);
    assert.equal(recovered.phase, 'lastwords');
    submit(recovered, hunter.id, { type: 'pass' });
    assert.equal(recovered.phase, 'sheriff_direction');
    assert.equal(recovered.winner, null);
  });
}

test('Postgres reopening a terminal legacy shot, badge or last words ends it before another action', async t => {
  const store = await diskStore(t);
  for (const phase of ['hunter', 'sheriff_transfer', 'lastwords']) {
    const g = game({ ...NEW_CONFIG, roles: { wolfKing: 1, villager: 4, seer: 1 }, victory: 'all' });
    const king = rolePlayer(g, 'wolfKing'), heir = rolePlayer(g, 'villager');
    // An earlier server saved a final exile and its unfinished death action.
    g.deadline = store.now + 30_000;
    g.phase = phase;
    g.resume = 'night';
    king.alive = phase !== 'lastwords';
    g.pendingHunters = phase === 'hunter' ? [king.id] : [];
    g.pendingBadgeId = phase === 'lastwords' ? null : king.id;
    g.sheriffId = g.pendingBadgeId;
    g.lastWordsQueue = [king.id];
    g.currentSpeakerId = phase === 'lastwords' ? king.id : null;
    await store.save(g);
    const recovered = await store.reopen();
    if (phase === 'sheriff_transfer') {
      assert.throws(() => act(recovered, king.id, { type: phase, targetId: heir.id }, store.now));
    } else advance(recovered, store.now);
    assert.equal(recovered.phase, 'finished');
    assert.equal(recovered.winner, 'good');
    assert.equal(recovered.players.find(p => p.id === king.id).alive, false);
    assert.deepEqual(recovered.hunterUsed, []);
    assert.deepEqual(recovered.pendingHunters, []);
    assert.equal(recovered.pendingBadgeId, null);
    assert.notEqual(recovered.sheriffId, heir.id);
    assert.equal(recovered.deadline, null);
    assert.equal(viewGame(recovered, king.id).actionable, false);
  }
});

test('Postgres reopens a legacy parallel night with public intervals and the original private ballots', async t => {
  const store = await diskStore(t);
  const g = game({ roles: { wolf: 1, guard: 1, seer: 1, witch: 1, villager: 2 }, victory: 'all', nightSeconds: 75 });
  delete g.night.sequential;
  g.night.windows = [
    { role: 'guard', offset: 0 }, { role: 'seer', offset: 0 },
    { role: 'wolf', offset: 45_000 }, { role: 'witch', offset: 75_000 },
  ];
  const wolf = rolePlayer(g, 'wolf'), villager = rolePlayer(g, 'villager');
  submit(g, wolf.id, { type: 'wolf', targetId: villager.id });
  await store.save(g);
  const restored = await store.reopen();
  const end = restored.deadline;
  const spectator = () => viewGame(restored, null);
  assert.deepEqual(spectator().nightStages, [
    { type: 'guard', label: '守卫行动', deadline: end },
    { type: 'wolf', label: '狼人行动', deadline: end + 45_000 },
    { type: 'seer', label: '预言家行动', deadline: end },
  ]);
  assert.equal(spectator().deadline, end);
  assert.deepEqual(spectator().privateInfo, {});
  assert.equal(spectator().action, null);
  assert.equal(viewGame(restored, wolf.id).action.deadline, end + 45_000);
  assert.equal(viewGame(restored, wolf.id).action.selected.targetId, villager.id);
  advance(restored, end);
  assert.equal(spectator().phaseLabel, '狼人行动');
  assert.equal(spectator().deadline, end + 45_000);
  advance(restored, end + 45_000);
  assert.equal(spectator().phaseLabel, '女巫行动');
  assert.equal(spectator().deadline, end + 75_000);
  assert.equal(viewGame(restored, rolePlayer(g, 'witch').id).privateInfo.nightVictim.id, villager.id);
  assert.deepEqual(spectator().privateInfo, {});
});

test('Postgres reopens a mixed legacy and current wolf history without disclosing it to other seats', async t => {
  const store = await diskStore(t);
  const g = game({ roles: { wolf: 1, wolfKing: 1, villager: 4 }, victory: 'all', nightSeconds: 75 });
  const wolves = g.players.filter(p => isWolfRole(p.role));
  const [firstVictim, secondTarget] = g.players.filter(p => p.role === 'villager');
  finishNight(g, firstVictim.id);
  const legacy = g.audit.find(row => row.round === 1 && row.text.startsWith('【复盘】狼人投票：'));
  delete legacy.wolfAttack;
  assert.equal(legacy.text, `【复盘】狼人投票：${wolves[0].seat} 号→${firstVictim.seat} 号，${wolves[1].seat} 号→${firstVictim.seat} 号；最终袭击：${firstVictim.seat} 号。`);
  const first = { round: 1, targetId: firstVictim.id, ballots: wolves.map(p => ({ playerId: p.id, targetId: firstVictim.id })) };
  finishDiscussion(g);
  advance(g, g.deadline);
  assert.equal(g.round, 2);
  assert.deepEqual(viewGame(g, wolves[0].id).privateInfo.wolfHistory, [first]);
  submit(g, wolves[0].id, { type: 'wolf', targetId: secondTarget.id });
  submit(g, wolves[0].id, { type: 'wolf', targetId: null });
  submit(g, wolves[1].id, { type: 'wolf', targetId: null });
  advance(g, g.deadline);
  const second = { round: 2, targetId: null, ballots: wolves.map(p => ({ playerId: p.id, targetId: null })) };
  await store.save(g);
  const recovered = await store.reopen();
  for (const wolf of wolves) {
    assert.deepEqual(viewGame(recovered, wolf.id).privateInfo.wolfHistory, [first, second]);
  }
  for (const viewer of [null, firstVictim.id, secondTarget.id]) {
    const v = viewGame(recovered, viewer);
    assert.ok(!Object.hasOwn(v.privateInfo, 'wolfHistory'));
    assert.ok(v.log.every(row => !row.text.includes('狼人投票：')));
  }
});
