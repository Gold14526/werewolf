import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_CONFIG, createGame, validateConfig, act, advance, viewGame, canChat, isWolfRole } from '../web/engine.js';

const ALL = { roles: { wolf: 1, wolfKing: 1, whiteWolfKing: 1, villager: 4, seer: 1, witch: 1, hunter: 1, fool: 1, knight: 1, guard: 1 }, victory: 'all', nightSeconds: 30, daySeconds: 60 };
function game(config = ALL) {
  const n = Object.values(config.roles).reduce((a, b) => a + b, 0);
  return createGame(Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `玩家${i + 1}`, seat: i + 1 })), config, { now: 1000, random: () => .999 });
}
const who = (g, role) => g.players.find(p => p.role === role);
const send = (g, id, action) => act(g, id, action, g.deadline - 1);
function night(g, options = {}) {
  for (let i = 0; i < 4 && ['guard', 'wolf', 'seer', 'witch'].includes(g.phase); i++) {
    const phase = g.phase;
    for (const p of g.players.filter(p => p.alive && (phase === 'wolf' ? isWolfRole(p.role) : p.role === phase))) {
      send(g, p.id, { type: phase, targetId: options[phase] ?? null, ...(phase === 'witch' ? { choice: options.witch ? 'poison' : 'skip' } : {}) });
    }
    advance(g, g.deadline);
  }
}
function speeches(g, phase = 'discussion') {
  while (g.phase === 'lastwords') send(g, g.currentSpeakerId, { type: 'pass' });
  if (g.phase === 'sheriff_direction') send(g, g.sheriffId, { type: 'sheriff_direction', choice: 'right' });
  while (g.phase === phase) send(g, g.currentSpeakerId, { type: 'pass' });
}
function exile(g, targetId) {
  speeches(g);
  for (const p of g.players) if (g.phase === 'vote' && viewGame(g, p.id).actionable) send(g, p.id, { type: 'vote', targetId: p.id === targetId ? null : targetId });
}
function signup(g, candidates) {
  assert.equal(g.phase, 'sheriff_signup');
  for (const p of g.players) send(g, p.id, { type: 'sheriff_signup', choice: candidates.includes(p.id) ? 'join' : 'skip' });
}
function singleSheriff(g, id) { night(g); signup(g, [id]); }
function assertRejectUnchanged(g, id, action) {
  const before = JSON.stringify(g);
  assert.throws(() => send(g, id, action));
  assert.equal(JSON.stringify(g), before);
}

test('special wolves count toward configuration balance and good specials count as gods', () => {
  assert.equal(validateConfig({ roles: { wolfKing: 1, villager: 4, fool: 1 } }).roles.wolf, 0);
  assert.equal(validateConfig({ roles: { whiteWolfKing: 1, villager: 4, knight: 1 } }).sheriff, false);
  assert.throws(() => validateConfig({ roles: { wolf: 1, wolfKing: 1, whiteWolfKing: 1, villager: 2, fool: 1 } }));
  assert.throws(() => validateConfig({ ...ALL, sheriff: 'yes' }));
  assert.throws(() => validateConfig({ ...ALL, roles: { ...ALL.roles, knight: 2 } }));
  assert.equal(STANDARD_CONFIG.sheriff, false);
  assert.equal(STANDARD_CONFIG.nightSeconds, 75);
  assert.equal(validateConfig({ roles: { wolfKing: 1, villager: 4, fool: 1 } }).nightSeconds, 75);
  for (const nightSeconds of [30, 45, 60, 75, 90]) assert.equal(validateConfig({ ...ALL, nightSeconds }).nightSeconds, nightSeconds);
  assert.throws(() => validateConfig({ ...ALL, nightSeconds: 65 }));
  assert.throws(() => validateConfig({ ...ALL, victory: 'either' }));
  assert.equal(Object.values(STANDARD_CONFIG.roles).reduce((a, b) => a + b), 12);
});

test('kings participate in wolf stage, hidden team chat and seer alignment without exact-role leak', () => {
  const g = game();
  advance(g, g.deadline);
  const kings = [who(g, 'wolfKing'), who(g, 'whiteWolfKing')], good = who(g, 'villager');
  for (const king of kings) {
    assert.equal(viewGame(g, king.id).actionable, true);
    assert.equal(canChat(g, king.id, 'wolf'), true);
    assert.equal(viewGame(g, king.id).privateInfo.wolfTeammates.length, 2);
    assert.equal(viewGame(g, good.id).players.find(p => p.id === king.id).role, undefined);
    send(g, king.id, { type: 'wolf', targetId: good.id });
  }
  advance(g, g.deadline);
  send(g, who(g, 'seer').id, { type: 'seer', targetId: kings[0].id }); advance(g, g.deadline);
  assert.equal(viewGame(g, who(g, 'seer').id).privateInfo.results[0].team, 'wolf');
  assert.equal(viewGame(g, who(g, 'seer').id).privateInfo.results[0].role, undefined);
});

test('a wolfKing-only deck retains night wolf stage and side victory', () => {
  const g = game({ roles: { wolfKing: 1, villager: 4, knight: 1 }, victory: 'side' });
  assert.equal(g.phase, 'wolf');
  const king = who(g, 'wolfKing'); night(g);
  assert.equal(g.winner, null);
  exile(g, king.id);
  assert.equal(g.phase, 'hunter');
  assert.equal(viewGame(g, king.id).phaseLabel, '狼王开枪');
  send(g, king.id, { type: 'hunter', targetId: null }); speeches(g, 'lastwords');
  assert.equal(g.winner, 'good');
});

test('voted wolf king can fire, but poison and self explosion suppress the gun', () => {
  const voted = game(); night(voted); exile(voted, who(voted, 'wolfKing').id);
  assert.equal(voted.phase, 'hunter');
  const victim = who(voted, 'villager'); send(voted, who(voted, 'wolfKing').id, { type: 'hunter', targetId: victim.id });
  assert.equal(victim.alive, false);
  const poisoned = game(); night(poisoned, { witch: who(poisoned, 'wolfKing').id });
  assert.equal(who(poisoned, 'wolfKing').alive, false); assert.equal(poisoned.pendingHunters.length, 0);
  const exploded = game(); night(exploded); send(exploded, who(exploded, 'wolfKing').id, { type: 'explode' });
  assert.equal(exploded.round, 2); assert.equal(exploded.pendingHunters.length, 0);
});

test('white king explosion carries hunter without gun or last words and cannot fire on ordinary death', () => {
  const g = game(); night(g); const king = who(g, 'whiteWolfKing'), hunter = who(g, 'hunter');
  assertRejectUnchanged(g, king.id, { type: 'explode', targetId: king.id });
  assertRejectUnchanged(g, who(g, 'wolf').id, { type: 'explode', targetId: hunter.id });
  send(g, king.id, { type: 'explode', targetId: hunter.id });
  assert.equal(king.alive, false); assert.equal(hunter.alive, false); assert.equal(g.pendingHunters.length, 0); assert.equal(g.lastWordsQueue.length, 0); assert.equal(g.round, 2);
  const exiled = game(); night(exiled); exile(exiled, who(exiled, 'whiteWolfKing').id);
  assert.equal(exiled.phase, 'lastwords'); assert.equal(exiled.pendingHunters.length, 0);
  const vote = game(); night(vote); speeches(vote);
  assertRejectUnchanged(vote, who(vote, 'whiteWolfKing').id, { type: 'explode', targetId: who(vote, 'hunter').id });
});

test('fool survives first exile, loses vote and targetability, but can die at night', () => {
  const g = game(); const fool = who(g, 'fool'); night(g); exile(g, fool.id);
  assert.equal(fool.alive, true); assert.equal(fool.foolRevealed, true); assert.equal(g.round, 2);
  assert.equal(viewGame(g, who(g, 'villager').id).players.find(p => p.id === fool.id).role, 'fool');
  night(g); speeches(g);
  assert.equal(viewGame(g, fool.id).actionable, false);
  assertRejectUnchanged(g, fool.id, { type: 'vote', targetId: who(g, 'wolf').id });
  assertRejectUnchanged(g, who(g, 'wolf').id, { type: 'vote', targetId: fool.id });
  advance(g, g.deadline); night(g, { wolf: fool.id });
  assert.equal(fool.alive, false);
});

test('knight duel of wolfKing suppresses gun, enters night, and cannot be reused', () => {
  const g = game(); night(g); const knight = who(g, 'knight'), king = who(g, 'wolfKing');
  assertRejectUnchanged(g, knight.id, { type: 'duel', targetId: knight.id });
  assertRejectUnchanged(g, who(g, 'seer').id, { type: 'duel', targetId: king.id });
  send(g, knight.id, { type: 'duel', targetId: king.id });
  assert.equal(king.alive, false); assert.equal(knight.alive, true); assert.equal(g.round, 2); assert.equal(g.pendingHunters.length, 0);
  night(g); assert.equal(viewGame(g, knight.id).canDuel, false);
  assertRejectUnchanged(g, knight.id, { type: 'duel', targetId: who(g, 'wolf').id });
});

test('failed knight duel preserves interrupted speech and removes dead knight from its queue', () => {
  const g = game(); night(g); const knight = who(g, 'knight'), target = who(g, 'villager');
  const speaker = g.currentSpeakerId, before = [...g.speechQueue];
  send(g, knight.id, { type: 'duel', targetId: target.id });
  assert.equal(knight.alive, false); assert.equal(target.alive, true); assert.equal(g.phase, 'discussion'); assert.equal(g.currentSpeakerId, speaker);
  assert.deepEqual(g.speechQueue, before.filter(id => id !== knight.id));
  assert.equal(g.round, 1);
});

test('signup keeps pending first-night death secret, candidates speak and original off-police voters elect', () => {
  const g = game({ ...ALL, sheriff: true }), victim = who(g, 'villager'), a = who(g, 'seer'), b = who(g, 'fool');
  night(g, { wolf: victim.id });
  assert.equal(g.phase, 'sheriff_signup'); assert.equal(victim.alive, true);
  assert.equal(viewGame(g, victim.id).night, undefined);
  signup(g, [a.id, b.id]); assert.equal(g.phase, 'sheriff_speech'); assert.equal(canChat(g, g.currentSpeakerId), true);
  speeches(g, 'sheriff_speech'); assert.equal(g.phase, 'sheriff_vote');
  assert.equal(viewGame(g, a.id).actionable, false);
  for (const id of [...g.sheriffVoters]) send(g, id, { type: 'sheriff_vote', targetId: a.id });
  assert.equal(g.sheriffId, a.id); assert.equal(victim.alive, false); assert.equal(g.phase, 'lastwords');
  speeches(g, 'lastwords'); assert.equal(g.phase, 'discussion'); assert.equal(g.speechQueue.at(-1), a.id);
});

test('withdrawal does not confer voting rights and cannot be used after voting starts', () => {
  const g = game({ ...ALL, sheriff: true }); night(g);
  const candidates = [who(g, 'seer').id, who(g, 'fool').id, who(g, 'knight').id]; signup(g, candidates);
  send(g, candidates[2], { type: 'withdraw' });
  assert.equal(g.sheriffCandidates.includes(candidates[2]), false); assert.equal(g.sheriffVoters.includes(candidates[2]), false);
  speeches(g, 'sheriff_speech'); assert.equal(viewGame(g, candidates[2]).actionable, false);
  assertRejectUnchanged(g, candidates[0], { type: 'withdraw' });
});

test('one candidate wins, no candidates or no electors yield no sheriff', () => {
  const one = game({ ...ALL, sheriff: true }); singleSheriff(one, who(one, 'seer').id);
  assert.equal(one.sheriffId, who(one, 'seer').id); assert.equal(one.phase, 'sheriff_direction');
  const none = game({ ...ALL, sheriff: true }); night(none); advance(none, none.deadline);
  assert.equal(none.sheriffId, null); assert.equal(none.phase, 'discussion');
  const all = game({ ...ALL, sheriff: true }); night(all); signup(all, all.players.map(p => p.id)); speeches(all, 'sheriff_speech');
  assert.equal(all.sheriffId, null); assert.equal(all.phase, 'discussion');
});

test('sheriff ties get one runoff then permanently lose badge, timeout advances safely', () => {
  const g = game({ roles: { wolf: 1, villager: 3, seer: 1, fool: 1 }, sheriff: true }); night(g);
  const [a, b] = [who(g, 'seer').id, who(g, 'fool').id]; signup(g, [a, b]); speeches(g, 'sheriff_speech');
  for (const [i, id] of [...g.sheriffVoters].entries()) send(g, id, { type: 'sheriff_vote', targetId: i % 2 ? a : b });
  assert.equal(g.phase, 'sheriff_speech'); assert.equal(g.sheriffRunoff, true);
  speeches(g, 'sheriff_speech');
  for (const [i, id] of [...g.sheriffVoters].entries()) send(g, id, { type: 'sheriff_vote', targetId: i % 2 ? a : b });
  assert.equal(g.sheriffId, null); assert.equal(g.phase, 'discussion'); assert.equal(g.sheriffElectionDone, true);
});

test('sheriff chooses circular order and is last; 1.5 exile vote breaks a one-to-one tie', () => {
  for (const direction of ['left', 'right']) {
    const g = game({ ...ALL, sheriff: true }), sheriff = who(g, 'seer'); singleSheriff(g, sheriff.id);
    assertRejectUnchanged(g, who(g, 'villager').id, { type: 'sheriff_direction', choice: 'right' });
    send(g, sheriff.id, { type: 'sheriff_direction', choice: direction });
    assert.equal(g.speechQueue.at(-1), sheriff.id);
    const expected = g.players.find(p => p.seat === sheriff.seat + (direction === 'left' ? -1 : 1));
    assert.equal(g.currentSpeakerId, expected.id);
    speeches(g);
    const a = who(g, 'villager'), b = who(g, 'fool');
    for (const p of g.players) if (g.phase === 'vote') send(g, p.id, { type: 'vote', targetId: p.id === sheriff.id ? a.id : p.id === a.id ? b.id : null });
    assert.equal(a.alive, false); assert.equal(b.alive, true); assert.equal(g.runoff, false);
  }
});

test('night-killed sheriff transfers badge before last words and new sheriff selects direction', () => {
  const g = game({ ...ALL, sheriff: true }), sheriff = who(g, 'seer'), successor = who(g, 'villager');
  night(g, { wolf: sheriff.id }); signup(g, [sheriff.id]);
  assert.equal(g.phase, 'sheriff_transfer'); assert.equal(sheriff.alive, false);
  assert.equal(viewGame(g, sheriff.id).actionable, true);
  assertRejectUnchanged(g, successor.id, { type: 'sheriff_transfer', targetId: successor.id });
  send(g, sheriff.id, { type: 'sheriff_transfer', targetId: successor.id });
  assert.equal(g.sheriffId, successor.id); assert.equal(g.phase, 'lastwords');
  send(g, sheriff.id, { type: 'pass' }); assert.equal(g.phase, 'sheriff_direction');
});

test('fool sheriff loses badge on flip and dead sheriff timeout tears badge', () => {
  const g = game({ ...ALL, sheriff: true }), fool = who(g, 'fool'); singleSheriff(g, fool.id); exile(g, fool.id);
  assert.equal(fool.alive, true); assert.equal(g.sheriffId, null); assert.equal(g.pendingBadgeId, null);
  const dead = game({ ...ALL, sheriff: true }), sheriff = who(dead, 'seer'); night(dead, { wolf: sheriff.id }); signup(dead, [sheriff.id]);
  assert.equal(dead.phase, 'sheriff_transfer'); advance(dead, dead.deadline);
  assert.equal(dead.pendingBadgeId, null); assert.equal(dead.sheriffId, null); assert.equal(dead.phase, 'lastwords');
});

test('election explosion cancels badge, honors poisoned king and independent first-night deaths', () => {
  const g = game({ ...ALL, sheriff: true }), king = who(g, 'wolfKing'), victim = who(g, 'seer');
  night(g, { wolf: victim.id, witch: king.id }); signup(g, [king.id, who(g, 'fool').id]);
  send(g, king.id, { type: 'explode' });
  assert.equal(g.sheriffElectionDone, true); assert.equal(g.sheriffId, null); assert.equal(victim.alive, false); assert.equal(king.alive, false);
  assert.equal(g.pendingHunters.length, 0); assert.deepEqual(g.lastWordsQueue, [victim.id]);
  send(g, victim.id, { type: 'pass' }); assert.equal(g.round, 2); assert.equal(g.phase, 'guard');
});

test('legacy snapshots without new fields resume existing phases and never start election', () => {
  let g = game(STANDARD_CONFIG); night(g);
  for (const key of ['sheriffId','sheriffElectionDone','sheriffCandidates','sheriffVoters','sheriffRunoff','pendingBadgeId','knightUsed']) delete g[key];
  delete g.config.sheriff;
  for (const role of ['wolfKing','whiteWolfKing','fool','knight']) delete g.config.roles[role];
  g = JSON.parse(JSON.stringify(g));
  assert.equal(viewGame(g, g.currentSpeakerId).canSpeak, true); exile(g, null);
  assert.equal(g.round, 2); assert.equal(g.phase, 'guard'); night(g);
  assert.equal(g.phase, 'discussion');
});
