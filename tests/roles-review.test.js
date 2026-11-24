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
  assert.equal(viewGame(g, null).players.find(p => p.id === hunter.id).publicRole, undefined);
  assert.equal(viewGame(g, null).players.find(p => p.id === white.id).publicRole, 'whiteWolfKing');
  assert.equal(g.sheriffElectionDone, true);
  assert.equal(g.sheriffId, null);
  assert.deepEqual(g.pendingHunters, []);
  assert.deepEqual(g.lastWordsQueue, [seer.id]);
  finishWords(g);
  assert.equal(g.round, 2);
  assert.ok(g.phase === 'night');
});

test('an unannounced first-night death is indistinguishable from no attack throughout the sheriff election', () => {
  const attacked = game(), safe = game();
  const victim = role(attacked, 'hunter'), candidate = role(attacked, 'fool');
  night(attacked, victim.id);
  night(safe);
  const viewers = [null, victim.id, candidate.id, role(attacked, 'villager').id];
  const checkViews = () => {
    for (const id of viewers) assert.deepEqual(viewGame(attacked, id), viewGame(safe, id));
  };
  checkViews();
  for (const g of [attacked, safe]) signup(g, [victim.id, candidate.id]);
  checkViews();
  for (const g of [attacked, safe]) {
    while (g.phase === 'sheriff_speech') submit(g, g.currentSpeakerId, { type: 'pass' });
    assert.equal(g.phase, 'sheriff_vote');
  }
  checkViews();
});

test('newly elected night-dead hunter sheriff resolves a wolf king gun chain before transferring once', () => {
  const g = game(), hunter = role(g, 'hunter'), king = role(g, 'wolfKing'), fool = role(g, 'fool'), knight = role(g, 'knight');
  night(g, hunter.id);
  signup(g, [hunter.id]);
  assert.equal(g.phase, 'hunter');
  assert.equal(hunter.alive, true);
  assert.equal(viewGame(g, hunter.id).actionable, true);
  assert.equal(viewGame(g, hunter.id).phase, 'hunter');
  assert.equal(viewGame(g, hunter.id).phaseLabel, '猎人开枪');
  for (const viewer of [null, fool.id]) {
    const v = viewGame(g, viewer);
    assert.equal(v.phase, 'resolution');
    assert.equal(v.phaseLabel, '技能结算');
    assert.equal(v.players.find(p => p.id === hunter.id).role, undefined);
    assert.doesNotMatch(v.log.map(m => m.text).join(' '), /猎人|狼王/);
  }
  submit(g, hunter.id, { type: 'hunter', targetId: king.id });
  assert.equal(g.phase, 'hunter');
  assert.match(viewGame(g, king.id).phaseLabel, /狼王/);
  const gallery = viewGame(g, null);
  assert.equal(gallery.players.find(p => p.id === hunter.id).publicRole, 'hunter');
  assert.equal(gallery.players.find(p => p.id === king.id).publicRole, undefined);
  assert.equal(hunter.alive, true, 'the shooter still owes a badge transfer');
  assert.equal(king.alive, true);
  assert.ok(viewGame(g, king.id).action.targets.every(p => p.id !== hunter.id && p.id !== king.id));
  assert.throws(() => submit(g, king.id, { type: 'hunter', targetId: hunter.id }));
  submit(g, king.id, { type: 'hunter', targetId: fool.id });
  assert.equal(g.phase, 'sheriff_transfer');
  assert.equal(hunter.alive, true);
  assert.equal(king.alive, false);
  assert.equal(viewGame(g, null).players.find(p => p.id === king.id).publicRole, 'wolfKing');
  assert.equal(viewGame(g, hunter.id).actionable, true);
  assert.equal(viewGame(g, king.id).actionable, false);
  assert.ok(viewGame(g, hunter.id).action.targets.every(p => ![hunter.id, king.id, fool.id].includes(p.id)));
  submit(g, hunter.id, { type: 'sheriff_transfer', targetId: knight.id });
  assert.equal(hunter.alive, false);
  finishWords(g);
  assert.equal(g.phase, 'sheriff_direction');
  assert.equal(g.sheriffId, knight.id);
  assert.equal(g.pendingBadgeId, null);
  assert.deepEqual(new Set(g.hunterUsed), new Set([hunter.id, king.id]));
});

test('a badge transferred after a gun chain may be transferred again by its next holder', () => {
  const g = game(), hunter = role(g, 'hunter'), king = role(g, 'wolfKing'), knight = role(g, 'knight');
  const heir = role(g, 'villager');
  night(g, hunter.id);
  signup(g, [king.id]);
  submit(g, hunter.id, { type: 'hunter', targetId: king.id });
  assert.equal(hunter.alive, false);
  assert.equal(king.alive, true);
  submit(g, king.id, { type: 'hunter', targetId: null });
  assert.equal(g.phase, 'sheriff_transfer');
  assert.equal(king.alive, true);
  assert.equal(viewGame(g, null).players.find(p => p.id === king.id).publicRole, undefined);
  submit(g, king.id, { type: 'sheriff_transfer', targetId: knight.id });
  assert.equal(king.alive, false);
  assert.equal(g.sheriffId, knight.id);
  finishWords(g);
  submit(g, knight.id, { type: 'sheriff_direction', choice: 'right' });
  submit(g, knight.id, { type: 'duel', targetId: heir.id });
  assert.equal(knight.alive, true);
  assert.equal(g.phase, 'sheriff_transfer');
  assert.throws(() => submit(g, king.id, { type: 'sheriff_transfer', targetId: heir.id }));
  submit(g, knight.id, { type: 'sheriff_transfer', targetId: heir.id });
  assert.equal(knight.alive, false);
  assert.equal(g.sheriffId, heir.id);
  assert.equal(g.pendingBadgeId, null);
  assert.equal(g.phase, 'discussion');
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
  assert.equal(knight.alive, true);
  assert.equal(target.alive, true);
  submit(g, knight.id, { type: 'sheriff_transfer', targetId: target.id });
  assert.equal(knight.alive, false);
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

test('living wolves see settled pack ballots, never private good actions or an inferred death', () => {
  const g = game({ ...CONFIG, sheriff: false });
  const wolves = g.players.filter(p => isWolfRole(p.role));
  const [wolf, king, white] = wolves;
  const guard = role(g, 'guard'), target = role(g, 'villager');
  const history = id => viewGame(g, id).privateInfo.wolfHistory;
  submit(g, guard.id, { type: 'guard', targetId: target.id });
  advance(g, g.deadline);
  submit(g, wolf.id, { type: 'wolf', targetId: guard.id });
  submit(g, wolf.id, { type: 'wolf', targetId: target.id });
  submit(g, king.id, { type: 'wolf', targetId: target.id });
  assert.deepEqual(history(white.id), []);
  advance(g, g.deadline);
  const entry = {
    round: 1, targetId: target.id,
    ballots: [wolf, king, white].map(p => ({ playerId: p.id, targetId: p === white ? null : target.id })),
  };
  for (const p of wolves) assert.deepEqual(history(p.id), [entry]);
  assert.equal(history(guard.id), undefined);
  assert.equal(history(null), undefined);
  const original = history(wolf.id);
  original[0].ballots[0].targetId = guard.id;
  assert.deepEqual(history(wolf.id), [entry]);

  while (g.phase === 'night') advance(g, g.deadline);
  assert.equal(target.alive, true, 'the guard stopped the attack');
  assert.deepEqual(history(wolf.id), [entry]);
  while (g.phase === 'discussion') submit(g, g.currentSpeakerId, { type: 'pass' });
  advance(g, g.deadline);
  advance(g, g.deadline);
  submit(g, wolf.id, { type: 'wolf', targetId: guard.id });
  submit(g, king.id, { type: 'wolf', targetId: target.id });
  assert.equal(history(king.id).length, 1);
  advance(g, g.deadline);
  assert.deepEqual(history(king.id).map(n => [n.round, n.targetId]), [[1, target.id], [2, null]]);
  assert.deepEqual(history(king.id)[1].ballots, [
    { playerId: wolf.id, targetId: guard.id }, { playerId: king.id, targetId: target.id }, { playerId: white.id, targetId: null },
  ]);
});

test('legacy wolf audit text is decoded by seat, unrelated entries excluded and target-only history survives rollover', () => {
  const g = game({ ...CONFIG, sheriff: false });
  const wolf = role(g, 'wolf'), king = role(g, 'wolfKing'), target = role(g, 'villager');
  g.round = 3;
  g.audit = [
    { round: 1, text: `【复盘】狼人投票：${wolf.seat} 号→${target.seat} 号，${king.seat} 号→无人；最终袭击：${target.seat} 号。` },
    { round: 1, text: '【复盘】女巫未使用药剂。' },
    { round: 2, text: `【复盘】狼人投票：${wolf.seat} 号→无人；最终袭击：无人。` },
    { round: 2, text: `【复盘】狼人投票：${king.seat} 号→无人；最终袭击：无人。`, wolfAttack: { targetId: null, ballots: [{ playerId: king.id, targetId: null }] } },
  ];
  const first = { round: 1, targetId: target.id, ballots: [{ playerId: wolf.id, targetId: target.id }, { playerId: king.id, targetId: null }] };
  const second = { round: 2, targetId: null, ballots: [{ playerId: king.id, targetId: null }] };
  const history = () => viewGame(g, wolf.id).privateInfo.wolfHistory;
  assert.deepEqual(history(), [first, second], 'no fabricated empty attack before the wolf window has opened');
  g.phase = 'vote';
  g.night.victim = target.id;
  const third = { round: 3, targetId: target.id, ballots: null };
  assert.deepEqual(history(), [first, second, third]);
  advance(g, g.deadline);
  assert.equal(g.round, 4);
  assert.deepEqual(history(), [first, second, third]);
  const loaded = JSON.parse(JSON.stringify(g));
  assert.deepEqual(viewGame(loaded, wolf.id).privateInfo.wolfHistory, [first, second, third]);
});

test('direct game projections for pending or eliminated wolves withhold the pack view, while endgame stays public', () => {
  const g = game({ ...CONFIG, sheriff: false });
  const king = role(g, 'wolfKing'), wolf = role(g, 'wolf');
  night(g, king.id);
  assert.equal(g.phase, 'hunter');
  const pending = viewGame(g, king.id);
  assert.equal(pending.action.type, 'hunter');
  assert.equal(pending.privateInfo.wolfHistory, undefined);
  assert.equal(pending.privateInfo.wolfTeammates, undefined);
  assert.equal(pending.players.find(p => p.id === wolf.id).role, undefined);
  assert.equal(viewGame(g, wolf.id).players.find(p => p.id === king.id).role, 'wolfKing');
  submit(g, king.id, { type: 'hunter', targetId: null });
  assert.equal(viewGame(g, king.id).privateInfo.wolfHistory, undefined);
  const copy = JSON.parse(JSON.stringify(g));
  copy.phase = 'finished';
  for (const id of [null, king.id, wolf.id]) {
    const replay = viewGame(copy, id);
    assert.equal(replay.privateInfo.wolfHistory, undefined);
    assert(replay.players.every(p => p.publicRole));
    assert(replay.log.some(entry => entry.text.startsWith('【复盘】狼人投票：')));
    assert(replay.log.every(entry => !('wolfAttack' in entry)));
  }
});
