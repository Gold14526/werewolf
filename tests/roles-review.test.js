import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, advance, viewGame, isWolfRole } from '../web/engine.js';

const CONFIG = { roles: { wolf: 1, wolfKing: 1, whiteWolfKing: 1, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1, fool: 1, knight: 1 }, victory: 'side', nightSeconds: 30, daySeconds: 60, sheriff: true };
function game(config = CONFIG, random = () => .999) {
  return createGame(Array.from({ length: Object.values(config.roles).reduce((a, b) => a + b, 0) }, (_, i) => ({ id: `review${i}`, name: `独立验收${i}`, seat: i + 1 })), config, { now: 1000, random });
}
const role = (g, r) => g.players.find(p => p.role === r);
const submit = (g, id, action) => act(g, id, action, g.deadline - 1);
function night(g, victim = null, poison = null) {
  while (g.phase === 'night') {
    for (const p of g.players) {
      const phase = viewGame(g, p.id).action?.type;
      if (!phase) continue;
      submit(g, p.id, { type: phase, targetId: phase === 'wolf' ? victim : phase === 'witch' ? poison : null, ...(phase === 'witch' ? { choice: poison ? 'poison' : 'skip' } : {}) });
    }
    advance(g, g.deadline);
  }
}
function signup(g, ids) {
  assert.equal(g.phase, 'sheriff_signup');
  for (const p of g.players) submit(g, p.id, { type: 'sheriff_signup', choice: ids.includes(p.id) ? 'join' : 'skip' });
}
function finishWords(g) {
  while (g.phase === 'lastwords') submit(g, g.currentSpeakerId, { type: 'pass' });
}

test('white king election carry suppresses a pending night victim gun without swallowing other night deaths', () => {
  const g = game(), hunter = role(g, 'hunter'), seer = role(g, 'seer'), white = role(g, 'whiteWolfKing');
  night(g, hunter.id, seer.id);
  signup(g, [white.id, role(g, 'villager').id]);
  submit(g, white.id, { type: 'explode', targetId: hunter.id });
  assert.equal(hunter.alive, false);
  assert.equal(seer.alive, false);
  assert.equal(g.sheriffElectionDone, true);
  assert.equal(g.sheriffId, null);
  assert.deepEqual(g.pendingHunters, []);
  assert.deepEqual(g.lastWordsQueue, [seer.id]);
  finishWords(g);
  assert.equal(g.round, 2);
  assert.ok(g.phase === 'night');
});

test('newly elected night-dead hunter sheriff resolves a wolf king gun chain before transferring once', () => {
  const g = game(), hunter = role(g, 'hunter'), king = role(g, 'wolfKing'), fool = role(g, 'fool'), knight = role(g, 'knight');
  night(g, hunter.id);
  signup(g, [hunter.id]);
  assert.equal(g.phase, 'hunter');
  assert.equal(viewGame(g, hunter.id).actionable, true);
  submit(g, hunter.id, { type: 'hunter', targetId: king.id });
  assert.equal(g.phase, 'hunter');
  assert.match(viewGame(g, king.id).phaseLabel, /狼王/);
  submit(g, king.id, { type: 'hunter', targetId: fool.id });
  assert.equal(g.phase, 'sheriff_transfer');
  assert.equal(viewGame(g, hunter.id).actionable, true);
  assert.equal(viewGame(g, king.id).actionable, false);
  assert.ok(viewGame(g, hunter.id).action.targets.every(p => ![hunter.id, king.id, fool.id].includes(p.id)));
  submit(g, hunter.id, { type: 'sheriff_transfer', targetId: knight.id });
  finishWords(g);
  assert.equal(g.phase, 'sheriff_direction');
  assert.equal(g.sheriffId, knight.id);
  assert.equal(g.pendingBadgeId, null);
  assert.deepEqual(new Set(g.hunterUsed), new Set([hunter.id, king.id]));
});

test('failed sheriff knight duel transfers badge and preserves the interrupted speech queue', () => {
  const g = game(), knight = role(g, 'knight'), target = role(g, 'villager');
  night(g);
  signup(g, [knight.id]);
  submit(g, knight.id, { type: 'sheriff_direction', choice: 'left' });
  const queue = [...g.speechQueue], speaker = g.currentSpeakerId;
  assert.notEqual(speaker, knight.id);
  submit(g, knight.id, { type: 'duel', targetId: target.id });
  assert.equal(g.phase, 'sheriff_transfer');
  assert.equal(target.alive, true);
  submit(g, knight.id, { type: 'sheriff_transfer', targetId: target.id });
  assert.equal(g.phase, 'discussion');
  assert.deepEqual(g.speechQueue, queue.filter(id => id !== knight.id));
  assert.equal(g.currentSpeakerId, speaker);
  assert.equal(viewGame(g, knight.id).canDuel, false);
});

test('failed duel by the current speaker does not skip the following living speaker', () => {
  const g = game({ ...CONFIG, sheriff: false }), knight = role(g, 'knight');
  night(g);
  while (g.currentSpeakerId !== knight.id) submit(g, g.currentSpeakerId, { type: 'pass' });
  const remainder = g.speechQueue.filter(id => id !== knight.id);
  submit(g, knight.id, { type: 'duel', targetId: role(g, 'villager').id });
  assert.equal(knight.alive, false);
  if (remainder.length) {
    assert.equal(g.phase, 'discussion');
    assert.equal(g.currentSpeakerId, remainder[0]);
  } else assert.equal(g.phase, 'vote');
});

test('role-rich randomized legal view actions always progress without hidden state in projections', () => {
  let seed = 0x12345678;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let match = 0; match < 200; match++) {
    const g = game({ ...CONFIG, sheriff: match % 2 === 0 }, random);
    for (let step = 0; step < 2500 && g.phase !== 'finished'; step++) {
      let candidates = [];
      for (const p of g.players) {
        const v = viewGame(g, p.id);
        for (const hidden of ['night', 'actions', 'pendingHunters', 'pendingBadgeId', 'resume', 'sheriffVoters', 'knightUsed']) assert.equal(Object.hasOwn(v, hidden), false);
        for (const shown of v.players.filter(q => q.role)) {
          const real = g.players.find(q => q.id === shown.id);
          assert.ok(shown.id === p.id || real.revealed || (isWolfRole(p.role) && isWolfRole(shown.role)));
        }
        if (v.actionable) candidates.push([p, v]);
      }
      const voluntary = g.players.map(p => [p, viewGame(g, p.id)]).filter(([, v]) => v.canDuel || v.canExplode || v.canWithdraw);
      if (voluntary.length && random() < .1) {
        const [p, v] = voluntary[Math.floor(random() * voluntary.length)];
        if (v.canDuel) submit(g, p.id, { type: 'duel', targetId: v.duelTargets[Math.floor(random() * v.duelTargets.length)].id });
        else if (v.canWithdraw && random() < .5) submit(g, p.id, { type: 'withdraw' });
        else if (v.canExplode) submit(g, p.id, { type: 'explode', targetId: v.explodeTargets.length && random() < .7 ? v.explodeTargets[Math.floor(random() * v.explodeTargets.length)].id : null });
        else advance(g, g.deadline);
      } else if (candidates.length && random() < .85) {
        const [p, v] = candidates[Math.floor(random() * candidates.length)];
        if (v.action.type === 'pass') submit(g, p.id, { type: 'pass' });
        else if (v.phase === 'sheriff_signup') submit(g, p.id, { type: v.phase, choice: random() < .45 ? 'join' : 'skip' });
        else if (v.phase === 'sheriff_direction') submit(g, p.id, { type: v.phase, choice: random() < .5 ? 'left' : 'right' });
        else if (v.action.type === 'witch') submit(g, p.id, { type: 'witch', choice: 'skip' });
        else submit(g, p.id, { type: v.action.type, targetId: v.action.targets.length && random() < .9 ? v.action.targets[Math.floor(random() * v.action.targets.length)].id : null });
      } else advance(g, g.deadline);
      assert.equal(new Set(g.hunterUsed).size, g.hunterUsed.length);
      assert.ok(!g.sheriffId || g.players.find(p => p.id === g.sheriffId)?.alive);
    }
    assert.equal(g.phase, 'finished', `match ${match} must finish`);
  }
});
