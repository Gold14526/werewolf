import test from 'node:test';
import assert from 'node:assert/strict';
import { act, advance, createGame, isPendingDeath, viewGame } from '../web/engine.js';

function game(roles, sheriff = false, victory = 'all') {
  const count = Object.values(roles).reduce((sum, amount) => sum + amount, 0);
  const players = Array.from({ length: count }, (_, i) => ({ id: 'p' + i, name: '玩家' + i }));
  return createGame(players, { roles, sheriff, victory, daySeconds: 60 }, { now: 1000, random: () => 0.99 });
}
const withRole = (g, role) => g.players.filter(p => p.role === role);
const submit = (g, actor, type, target = null) => act(g, actor.id, { type, targetId: target?.id ?? null }, g.deadline - 1);
const publicSeat = (g, p) => viewGame(g, null).players.find(seat => seat.id === p.id);
function night(g, victim = null, poison = null) {
  while (g.phase === 'night') {
    for (const actor of g.players) {
      const action = viewGame(g, actor.id).action;
      if (action?.type === 'wolf') submit(g, actor, 'wolf', victim);
      if (action?.type === 'witch' && poison) {
        act(g, actor.id, { type: 'witch', choice: 'poison', targetId: poison.id }, g.deadline - 1);
      }
    }
    advance(g, g.deadline);
  }
}
function elect(g, sheriff) {
  for (const actor of g.players) act(g, actor.id, { type: 'sheriff_signup', choice: actor.id === sheriff.id ? 'join' : 'skip' }, g.deadline - 1);
}
function finishWords(g) {
  while (g.phase === 'lastwords') act(g, g.currentSpeakerId, { type: 'pass' }, g.deadline - 1);
}

test('two wolf kings and a sheriff hunter may each shoot once before leaving their own seat', () => {
  const g = game({ wolf: 1, wolfKing: 2, hunter: 1, villager: 4 }, true);
  const [first, second] = withRole(g, 'wolfKing'), [hunter] = withRole(g, 'hunter'), [heir] = withRole(g, 'villager');
  night(g, hunter);
  elect(g, hunter);
  assert.equal(g.phase, 'hunter');
  assert.equal(g.winner, null);
  assert.equal(publicSeat(g, hunter).alive, true);
  assert.equal(publicSeat(g, hunter).role, undefined);
  assert.equal(viewGame(g, null).phaseLabel, '技能结算');
  assert(!viewGame(g, null).log.some(e => /猎人|狼王|开枪/.test(e.text)));
  assert.equal(viewGame(g, hunter.id).phaseLabel, '猎人开枪');
  assert.throws(() => submit(g, hunter, 'hunter', hunter));

  submit(g, hunter, 'hunter', first);
  assert.equal(publicSeat(g, hunter).role, 'hunter');
  assert.equal(hunter.alive, true, 'the hunter still has the badge to transfer');
  assert(isPendingDeath(g, hunter.id));
  assert(first.alive && isPendingDeath(g, first.id));
  assert.equal(publicSeat(g, first).role, undefined);
  assert(!viewGame(g, first.id).action.targets.some(p => [hunter.id, first.id].includes(p.id)));
  assert.throws(() => submit(g, first, 'hunter', hunter));
  assert.throws(() => submit(g, hunter, 'hunter', heir));

  submit(g, first, 'hunter', second);
  assert.equal(first.alive, false);
  assert.equal(publicSeat(g, first).role, 'wolfKing');
  assert.equal(publicSeat(g, second).role, undefined);
  assert(second.alive && isPendingDeath(g, second.id));
  assert.equal(g.winner, null);
  submit(g, second, 'hunter');
  assert.equal(second.alive, false);
  assert.equal(publicSeat(g, second).role, undefined, 'the second king never fired');
  assert.equal(g.phase, 'sheriff_transfer');
  assert(hunter.alive && isPendingDeath(g, hunter.id));
  assert.throws(() => submit(g, hunter, 'sheriff_transfer', first));
  assert.throws(() => submit(g, hunter, 'sheriff_transfer', hunter));
  submit(g, hunter, 'sheriff_transfer', heir);
  assert.equal(hunter.alive, false);
  assert.equal(isPendingDeath(g, hunter.id), false);
  assert.equal(g.sheriffId, heir.id);
  assert.equal(g.phase, 'lastwords');
  assert.deepEqual(g.hunterUsed, [hunter.id, first.id, second.id]);
  assert.deepEqual(g.lastWordsQueue, [hunter.id, first.id, second.id]);
  finishWords(g);
  assert.equal(g.phase, 'sheriff_direction');
  assert.equal(g.winner, null);
});

test('both an explicit pass and timeout finish an unrevealed shooter without publishing their identity', () => {
  for (const timeout of [false, true]) {
    const g = game({ wolf: 1, hunter: 1, villager: 4 });
    const [hunter] = withRole(g, 'hunter');
    night(g, hunter);
    assert(hunter.alive);
    assert.equal(publicSeat(g, hunter).role, undefined);
    if (timeout) advance(g, g.deadline);
    else submit(g, hunter, 'hunter');
    assert.equal(hunter.alive, false);
    assert.equal(isPendingDeath(g, hunter.id), false);
    assert.deepEqual(g.hunterUsed, [hunter.id]);
    assert.equal(publicSeat(g, hunter).role, undefined);
    assert(!viewGame(g, null).log.some(e => /猎人|狼王|开枪/.test(e.text)));
    assert.equal(g.phase, 'lastwords');
  }
});

test('poison suppresses the gun while a sheriff killed by poison still decides the badge before exiting', () => {
  const g = game({ wolfKing: 1, witch: 1, hunter: 1, villager: 3 }, true);
  const [hunter] = withRole(g, 'hunter');
  night(g, hunter, hunter);
  elect(g, hunter);
  assert.equal(g.phase, 'sheriff_transfer');
  assert.deepEqual(g.pendingHunters, []);
  assert.equal(hunter.alive, true);
  advance(g, g.deadline);
  assert.equal(hunter.alive, false);
  assert.equal(g.sheriffId, null);
  assert.deepEqual(g.hunterUsed, []);
  assert.equal(publicSeat(g, hunter).role, undefined);
});

test('each white king can sacrifice only themselves and their victim, suppressing a wolf king or hunter gun', () => {
  const g = game({ whiteWolfKing: 2, wolfKing: 1, hunter: 1, villager: 4 });
  const [firstWhite, secondWhite] = withRole(g, 'whiteWolfKing'), [king] = withRole(g, 'wolfKing'), [hunter] = withRole(g, 'hunter');
  night(g);
  submit(g, firstWhite, 'explode', king);
  assert.equal(g.phase, 'night');
  assert(!firstWhite.alive && !king.alive);
  assert(secondWhite.alive && hunter.alive);
  assert.deepEqual(g.pendingHunters, []);
  night(g);
  submit(g, secondWhite, 'explode', hunter);
  assert(!secondWhite.alive && !hunter.alive);
  assert.deepEqual(g.pendingHunters, []);
  assert.deepEqual(g.hunterUsed, []);
  assert.equal(g.winner, 'good');
});

test('a legacy night-killed sheriff remains dead but can finish their queued gun and badge exactly once', () => {
  let g = game({ wolf: 1, wolfKing: 1, hunter: 1, villager: 4 }, true);
  const [hunter] = withRole(g, 'hunter'), [wolf] = withRole(g, 'wolfKing'), [heir] = withRole(g, 'villager');
  night(g, hunter);
  elect(g, hunter);
  hunter.alive = false;
  hunter.revealed = true;
  g.sheriffId = null;
  g = JSON.parse(JSON.stringify(g));
  assert.equal(publicSeat(g, hunter).alive, false);
  assert.equal(publicSeat(g, hunter).role, 'hunter');
  assert(isPendingDeath(g, hunter.id));
  submit(g, hunter, 'hunter', wolf);
  assert.equal(publicSeat(g, hunter).alive, false);
  assert.throws(() => submit(g, hunter, 'hunter', heir));
  advance(g, g.deadline);
  assert.equal(g.phase, 'sheriff_transfer');
  submit(g, hunter, 'sheriff_transfer', heir);
  assert.equal(publicSeat(g, hunter).alive, false);
  assert.equal(g.sheriffId, heir.id);
  assert.deepEqual(g.hunterUsed, [hunter.id, wolf.id]);
  assert.equal(isPendingDeath(g, hunter.id), false);
});

function assertImmediateWin(g, winner, fallen) {
  assert.equal(g.phase, 'finished');
  assert.equal(g.winner, winner);
  assert.equal(g.deadline, null);
  assert.equal(g.currentSpeakerId, null);
  assert.deepEqual(g.pendingHunters, []);
  assert.equal(g.pendingBadgeId, null);
  for (const p of fallen) {
    assert.equal(publicSeat(g, p).alive, false);
    assert.equal(isPendingDeath(g, p.id), false);
    assert.equal(viewGame(g, p.id).actionable, false);
  }
}

test('losing the last god or the last good player skips both the hunter shot and badge transfer', () => {
  for (const victory of ['side', 'all']) {
    const g = game({ wolf: 1, hunter: 1, villager: 4 }, true, victory);
    const [hunter] = withRole(g, 'hunter');
    g.round = 2;
    g.sheriffId = hunter.id;
    if (victory === 'all') for (const p of withRole(g, 'villager')) p.alive = false;
    night(g, hunter);
    assertImmediateWin(g, 'wolf', [hunter]);
    assert.deepEqual(g.hunterUsed, []);
    assert.throws(() => submit(g, hunter, 'hunter', withRole(g, 'wolf')[0]));
  }
});

test('night casualties settle together when poison clears the village and the wolves hit a hunter', () => {
  const g = game({ wolf: 1, hunter: 2, witch: 1, seer: 1, villager: 1 }, false, 'side');
  const [hunter] = withRole(g, 'hunter'), [villager] = withRole(g, 'villager');
  night(g, hunter, villager);
  assertImmediateWin(g, 'wolf', [hunter, villager]);
  assert.deepEqual(g.hunterUsed, []);
});

test('a batch that kills every participant preserves the existing last-wolf victory priority', () => {
  const g = game({ wolfKing: 1, witch: 5 });
  const [king] = withRole(g, 'wolfKing'), witches = withRole(g, 'witch');
  submit(g, king, 'wolf', witches[0]);
  advance(g, g.deadline);
  for (const [index, w] of witches.entries()) {
    act(g, w.id, { type: 'witch', choice: 'poison', targetId: index === 0 ? king.id : w.id }, g.deadline - 1);
  }
  advance(g, g.deadline);
  assertImmediateWin(g, 'good', g.players);
});

test('a lethal second shot in a chain cancels the last wolf king’s shot and a waiting badge', () => {
  const g = game({ wolfKing: 2, hunter: 1, villager: 4 }, true);
  const [hunter] = withRole(g, 'hunter'), [first, last] = withRole(g, 'wolfKing');
  night(g, hunter);
  elect(g, hunter);
  submit(g, hunter, 'hunter', first);
  assert.equal(g.phase, 'hunter');
  assert.equal(g.winner, null);
  submit(g, first, 'hunter', last);
  assertImmediateWin(g, 'good', [hunter, first, last]);
  assert.deepEqual(g.hunterUsed, [hunter.id, first.id]);
  assert.throws(() => submit(g, last, 'hunter', withRole(g, 'villager')[0]));
});
