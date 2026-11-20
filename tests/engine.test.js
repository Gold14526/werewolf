import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_CONFIG, validateConfig, createGame, act as submit, advance, viewGame, canChat } from '../web/engine.js';

// Drive the clock to the fixed deadline after a night stage's actors submit.
// Production uses its server tick; these tests should not wait in real time.
function act(g, playerId, action, now) {
  const phase = g.phase;
  const result = submit(g, playerId, action, now);
  if (['guard', 'wolf', 'seer', 'witch'].includes(phase) && g.phase === phase &&
      g.players.filter(p => p.alive && p.role === phase).every(p => Object.hasOwn(g.actions, p.id))) advance(g, g.deadline);
  return result;
}

const SIX = { roles: { wolf: 1, villager: 1, seer: 1, witch: 1, hunter: 1, guard: 1 }, victory: 'side', nightSeconds: 30, daySeconds: 60 };
function game(config = SIX) {
  const total = Object.values(config.roles).reduce((a, b) => a + b, 0);
  return createGame(Array.from({ length: total }, (_, i) => ({ id: `p${i + 1}`, name: `玩家${i + 1}`, seat: i + 1 })), config, { now: 1000, random: () => 0.999 });
}
const id = (g, role) => g.players.find(p => p.role === role).id;
function play(g, role, targetId = null, choice) {
  return act(g, id(g, role), { type: g.phase, targetId, choice }, g.deadline - 1);
}
function night(g, { guard = null, wolf = null, seer = null, witch = 'skip', poison = null } = {}) {
  if (g.phase === 'guard') {
    if (g.players.some(p => p.role === 'guard' && p.alive)) play(g, 'guard', guard);
    else advance(g, g.deadline);
  }
  if (g.phase === 'wolf') {
    for (const p of g.players.filter(p => p.role === 'wolf' && p.alive)) act(g, p.id, { type: 'wolf', targetId: wolf }, g.deadline - 1);
  }
  if (g.phase === 'seer') {
    if (g.players.some(p => p.role === 'seer' && p.alive)) play(g, 'seer', seer);
    else advance(g, g.deadline);
  }
  if (g.phase === 'witch') {
    if (g.players.some(p => p.role === 'witch' && p.alive)) play(g, 'witch', poison, witch);
    else advance(g, g.deadline);
  }
}
function lastwords(g) {
  while (g.phase === 'lastwords') act(g, g.currentSpeakerId, { type: 'pass' }, g.deadline - 1);
}
function discussion(g) {
  lastwords(g);
  assert.equal(g.phase, 'discussion');
  while (g.phase === 'discussion') act(g, g.currentSpeakerId, { type: 'pass' }, g.deadline - 1);
  assert.equal(g.phase, 'vote');
}
function vote(g, targetId) {
  discussion(g);
  for (const p of g.players.filter(p => p.alive)) act(g, p.id, { type: 'vote', targetId: p.id === targetId ? null : targetId }, g.deadline - 1);
  lastwords(g);
}

test('standard deck has 12 roles and distinct assigned players', () => {
  const g = game(STANDARD_CONFIG);
  assert.equal(g.players.length, 12);
  for (const [role, count] of Object.entries(STANDARD_CONFIG.roles)) assert.equal(g.players.filter(p => p.role === role).length, count);
  assert.equal(g.phase, 'guard');
  assert.equal(g.deadline, 46000);
});

test('rejects impossible and malformed configurations', () => {
  for (const input of [null, [], { ...SIX, roles: { ...SIX.roles, wolf: -1 } }, { ...SIX, roles: { ...SIX.roles, witch: 2 } }, { ...SIX, roles: { wolf: 4, villager: 4 } }, { ...SIX, roles: { wolf: 1, villager: 5 } }, { ...SIX, roles: { ...SIX.roles, dragon: 1 } }, { ...SIX, daySeconds: 1 }]) assert.throws(() => validateConfig(input));
  assert.equal(validateConfig({ roles: { wolf: 1, villager: 5 }, victory: 'all' }).roles.seer, 0);
});

test('public view never discloses other good roles or internal night state', () => {
  const g = game(STANDARD_CONFIG);
  const villager = viewGame(g, id(g, 'villager'));
  assert.equal(villager.myRole, 'villager');
  assert.equal(villager.players.filter(p => p.role).length, 1);
  for (const key of ['night', 'actions', 'audit', 'investigations', 'potions', 'pendingHunters']) assert.equal(key in villager, false);
  const wolf = viewGame(g, id(g, 'wolf'));
  assert.equal(wolf.players.filter(p => p.role).length, 4);
  assert.equal(wolf.privateInfo.wolfTeammates.length, 3);
  assert.throws(() => viewGame(g, 'outsider'));
});

test('enforces phase, actor, alive target and duplicate submission permissions', () => {
  const g = game(STANDARD_CONFIG);
  assert.throws(() => act(g, id(g, 'villager'), { type: 'guard', targetId: null }, 1001));
  assert.throws(() => play(g, 'guard', 'missing'));
  assert.throws(() => act(g, id(g, 'guard'), { type: 'vote', targetId: null }, 1001));
  play(g, 'guard');
  const wolf = id(g, 'wolf');
  act(g, wolf, { type: 'wolf', targetId: null }, 1001);
  assert.throws(() => act(g, wolf, { type: 'wolf', targetId: null }, 1002));
  assert.equal(viewGame(g, wolf).submitted, true);
});

test('seer result is private and identifies team rather than special role', () => {
  const g = game();
  play(g, 'guard'); play(g, 'wolf');
  play(g, 'seer', id(g, 'witch'));
  const result = viewGame(g, id(g, 'seer')).privateInfo.results[0];
  assert.equal(result.team, 'good');
  assert.equal('role' in result, false);
  assert.equal(viewGame(g, id(g, 'villager')).privateInfo.results, undefined);
});

test('night kill resolves only at dawn and side victory recognizes villagers', () => {
  const g = game();
  play(g, 'guard'); play(g, 'wolf', id(g, 'villager'));
  assert.equal(g.players.find(p => p.role === 'villager').alive, true);
  play(g, 'seer'); play(g, 'witch', null, 'skip');
  assert.equal(g.players.find(p => p.role === 'villager').alive, false);
  lastwords(g);
  assert.equal(g.winner, 'wolf');
  assert.equal(viewGame(g, id(g, 'villager')).players.filter(p => p.role).length, 6);
});

test('guard protects, cannot repeat, and a skipped guard resets restriction', () => {
  const g = game();
  const target = id(g, 'villager');
  night(g, { guard: target, wolf: target });
  assert.equal(g.phase, 'discussion');
  assert.equal(g.players.find(p => p.id === target).alive, true);
  vote(g, null);
  assert.equal(g.round, 2);
  assert.equal(viewGame(g, id(g, 'guard')).action.targets.some(p => p.id === target), false);
  assert.throws(() => play(g, 'guard', target));
  night(g);
  vote(g, null);
  assert.equal(viewGame(g, id(g, 'guard')).action.targets.some(p => p.id === target), true);
});

test('guard and witch save on the same target still cause death', () => {
  const g = game();
  night(g, { guard: id(g, 'villager'), wolf: id(g, 'villager'), witch: 'save' });
  assert.equal(g.players.find(p => p.role === 'villager').alive, false);
  assert.equal(g.potions.save, false);
});

test('witch saves once, hides later wolf targets, and cannot spend both potions', () => {
  const g = game();
  const target = id(g, 'seer');
  play(g, 'guard'); play(g, 'wolf', target); play(g, 'seer');
  assert.equal(viewGame(g, id(g, 'witch')).privateInfo.nightVictim.id, target);
  assert.throws(() => play(g, 'witch', null, 'both'));
  play(g, 'witch', null, 'save');
  assert.equal(g.players.find(p => p.id === target).alive, true);
  vote(g, null);
  play(g, 'guard'); play(g, 'wolf', target); play(g, 'seer');
  const view = viewGame(g, id(g, 'witch'));
  assert.equal('nightVictim' in view.privateInfo, false);
  assert.equal(view.action.choices.includes('save'), false);
  assert.throws(() => play(g, 'witch', null, 'save'));
});

test('witch may self-save only during first night', () => {
  const first = game();
  night(first, { wolf: id(first, 'witch'), witch: 'save' });
  assert.equal(first.players.find(p => p.role === 'witch').alive, true);
  const second = game();
  night(second); vote(second, null);
  play(second, 'guard'); play(second, 'wolf', id(second, 'witch')); play(second, 'seer');
  assert.throws(() => play(second, 'witch', null, 'save'));
});

test('poison ignores protection and prevents hunter shot', () => {
  const g = game();
  const hunter = id(g, 'hunter');
  night(g, { guard: hunter, poison: hunter, witch: 'poison' });
  assert.equal(g.players.find(p => p.id === hunter).alive, false);
  lastwords(g);
  assert.equal(g.phase, 'discussion');
  assert.equal(g.potions.poison, false);
});

test('hunter killed at night can shoot and victory waits for that shot', () => {
  const g = game();
  night(g, { wolf: id(g, 'hunter') });
  assert.equal(g.phase, 'hunter');
  assert.equal(g.winner, null);
  assert.equal(viewGame(g, id(g, 'hunter')).actionable, true);
  play(g, 'hunter', id(g, 'wolf'));
  lastwords(g);
  assert.equal(g.winner, 'good');
});

test('exiled hunter can shoot and resumes following night on abstention', () => {
  const g = game();
  night(g); vote(g, id(g, 'hunter'));
  assert.equal(g.phase, 'hunter');
  play(g, 'hunter');
  lastwords(g);
  assert.equal(g.phase, 'guard');
  assert.equal(g.round, 2);
});

test('equal daytime votes do not eliminate anyone', () => {
  const g = game();
  night(g); discussion(g);
  const before = g.players.filter(p => p.alive).length;
  for (const [i, p] of g.players.entries()) act(g, p.id, { type: 'vote', targetId: g.players[(i + 1) % 2].id }, g.deadline - 1);
  assert.equal(g.phase, 'discussion');
  assert.equal(g.runoff, true);
  discussion(g);
  for (const [i, p] of g.players.slice(2).entries()) act(g, p.id, { type: 'vote', targetId: g.players[i % 2].id }, g.deadline - 1);
  assert.equal(g.players.filter(p => p.alive).length, before);
  assert.equal(g.round, 2);
});

test('tied wolves abstain from killing', () => {
  const g = game(STANDARD_CONFIG);
  play(g, 'guard');
  const wolves = g.players.filter(p => p.role === 'wolf');
  for (const [i, p] of wolves.entries()) act(g, p.id, { type: 'wolf', targetId: g.players[4 + i % 2].id }, g.deadline - 1);
  play(g, 'seer'); play(g, 'witch', null, 'skip');
  assert.equal(g.players.filter(p => p.alive).length, 12);
});

test('timeouts skip actions, preserve full next-phase timer and reject late submissions', () => {
  const g = game();
  const deadline = g.deadline;
  advance(g, deadline - 1); assert.equal(g.phase, 'guard');
  assert.throws(() => act(g, id(g, 'guard'), { type: 'guard', targetId: null }, deadline));
  assert.equal(g.phase, 'wolf');
  assert.equal(g.deadline, deadline + 30000);
  advance(g, deadline + 900000);
  assert.equal(g.phase, 'seer');
  assert.equal(g.deadline, deadline + 930000);
});

test('all victory requires eliminating every good player instead of one side', () => {
  const g = game({ ...SIX, victory: 'all' });
  night(g, { wolf: id(g, 'villager') });
  assert.equal(g.winner, null);
  lastwords(g);
  assert.equal(g.phase, 'discussion');
  vote(g, id(g, 'wolf'));
  assert.equal(g.winner, 'good');
});

test('view copies cannot mutate authoritative secrets or player state', () => {
  const g = game();
  const view = viewGame(g, id(g, 'witch'));
  view.players[0].alive = false;
  view.config.roles.wolf = 100;
  view.privateInfo.potions.save = false;
  assert.equal(g.players[0].alive, true);
  assert.equal(g.config.roles.wolf, 1);
  assert.equal(g.potions.save, true);
});

test('public speech is restricted to the current player and pass moves in seat order', () => {
  const g = game();
  night(g);
  assert.equal(g.currentSpeakerId, 'p1');
  assert.equal(canChat(g, 'p1'), true);
  assert.equal(canChat(g, 'p2'), false);
  assert.equal(viewGame(g, 'p1').canSpeak, true);
  assert.equal(viewGame(g, 'p1').actionable, true);
  assert.deepEqual(viewGame(g, 'p1').action, { type: 'pass', targets: [] });
  assert.throws(() => act(g, 'p2', { type: 'pass' }, g.deadline - 1));
  act(g, 'p1', { type: 'pass' }, g.deadline - 1);
  assert.equal(g.currentSpeakerId, 'p2');
  assert.equal(canChat(g, 'p1'), false);
  assert.equal(canChat(g, 'p2'), true);
  const before = g.deadline;
  advance(g, before);
  assert.equal(g.currentSpeakerId, 'p3');
  assert.equal(g.deadline, before + SIX.daySeconds * 1000);
});

test('first-night victims receive last words and second-night victims do not', () => {
  const g = game({ ...SIX, victory: 'all' });
  night(g, { wolf: id(g, 'seer') });
  assert.equal(g.phase, 'lastwords');
  assert.equal(g.currentSpeakerId, id(g, 'seer'));
  assert.equal(canChat(g, id(g, 'seer')), true);
  assert.equal(canChat(g, id(g, 'villager')), false);
  lastwords(g);
  assert.equal(g.phase, 'discussion');
  assert.equal(g.speechQueue.includes(id(g, 'seer')), false);
  vote(g, null);
  night(g, { wolf: id(g, 'villager') });
  assert.equal(g.phase, 'discussion');
  assert.equal(canChat(g, id(g, 'villager')), false);
});

test('voted player receives last words before the next night', () => {
  const g = game({ ...SIX, victory: 'all' });
  night(g); discussion(g);
  const targetId = id(g, 'seer');
  for (const p of g.players) act(g, p.id, { type: 'vote', targetId: p.id === targetId ? null : targetId }, g.deadline - 1);
  assert.equal(g.phase, 'lastwords');
  assert.equal(g.currentSpeakerId, targetId);
  lastwords(g);
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'guard');
});

test('self votes are rejected and PK limits speakers, voters and targets', () => {
  const g = game();
  night(g); discussion(g);
  assert.throws(() => act(g, 'p1', { type: 'vote', targetId: 'p1' }, g.deadline - 1));
  for (const [i, p] of g.players.entries()) act(g, p.id, { type: 'vote', targetId: g.players[(i + 1) % 2].id }, g.deadline - 1);
  assert.equal(g.runoff, true);
  assert.deepEqual(g.speechQueue, ['p1', 'p2']);
  discussion(g);
  assert.equal(viewGame(g, 'p1').actionable, false);
  assert.throws(() => act(g, 'p1', { type: 'vote', targetId: 'p2' }, g.deadline - 1));
  assert.deepEqual(new Set(viewGame(g, 'p3').action.targets.map(p => p.id)), new Set(['p1', 'p2']));
  assert.throws(() => act(g, 'p3', { type: 'vote', targetId: 'p4' }, g.deadline - 1));
  for (const p of g.players.slice(2)) act(g, p.id, { type: 'vote', targetId: 'p1' }, g.deadline - 1);
  assert.equal(g.phase, 'lastwords');
  lastwords(g);
  assert.equal(g.winner, 'good');
});

test('only wolves see wolf ballots and living wolves chat only during wolf phase', () => {
  const g = game(STANDARD_CONFIG);
  const wolves = g.players.filter(p => p.role === 'wolf');
  assert.equal(canChat(g, wolves[0].id, 'wolf'), false);
  play(g, 'guard');
  assert.equal(canChat(g, wolves[0].id, 'wolf'), true);
  assert.equal(canChat(g, id(g, 'villager'), 'wolf'), false);
  act(g, wolves[0].id, { type: 'wolf', targetId: id(g, 'villager') }, g.deadline - 1);
  assert.deepEqual(viewGame(g, wolves[1].id).privateInfo.wolfVotes, [{ playerId: wolves[0].id, targetId: id(g, 'villager') }]);
  assert.equal(viewGame(g, id(g, 'villager')).privateInfo.wolfVotes, undefined);
});

test('wolf explosion reveals role and interrupts speeches or voting', () => {
  for (const phase of ['discussion', 'vote']) {
    const g = game(STANDARD_CONFIG);
    night(g);
    if (phase === 'vote') discussion(g);
    const wolf = id(g, 'wolf');
    assert.equal(viewGame(g, wolf).canExplode, true);
    assert.throws(() => act(g, id(g, 'villager'), { type: 'explode' }, g.deadline - 1));
    act(g, wolf, { type: 'explode' }, g.deadline - 1);
    assert.equal(g.phase, 'guard');
    assert.equal(g.round, 2);
    assert.equal(g.players.find(p => p.id === wolf).alive, false);
    assert.equal(viewGame(g, id(g, 'villager')).players.find(p => p.id === wolf).role, 'wolf');
    assert.equal(viewGame(g, wolf).canExplode, false);
  }
});

test('draw happens after exactly 20 rounds without a winning side', () => {
  const g = game();
  for (let round = 1; round <= 20; round++) {
    assert.equal(g.round, round);
    night(g);
    vote(g, null);
  }
  assert.equal(g.phase, 'finished');
  assert.equal(g.winner, 'draw');
  assert.equal(g.round, 20);
  assert.equal(g.deadline, null);
  assert.equal(canChat(g, 'p1'), true);
  assert.throws(() => act(g, 'p1', { type: 'explode' }, 100000000));
});

test('night stages use fixed deadlines and configured dead roles retain their stage', () => {
  const g = game({ ...SIX, victory: 'all' });
  const firstDeadline = g.deadline;
  submit(g, id(g, 'guard'), { type: 'guard', targetId: null }, firstDeadline - 10000);
  assert.equal(g.phase, 'guard');
  assert.equal(g.deadline, firstDeadline);
  assert.equal(viewGame(g, id(g, 'guard')).submitted, true);
  advance(g, firstDeadline);
  night(g, { wolf: id(g, 'guard') });
  lastwords(g);
  vote(g, null);
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'guard');
  assert.equal(g.players.find(p => p.role === 'guard').alive, false);
  assert.equal(viewGame(g, id(g, 'villager')).players.find(p => p.id === id(g, 'guard')).role, undefined);
  const deadline = g.deadline;
  advance(g, deadline - 1); assert.equal(g.phase, 'guard');
  advance(g, deadline); assert.equal(g.phase, 'wolf');
});

test('skill audit is entirely private until the finished replay', () => {
  const g = game();
  night(g, { guard: id(g, 'villager'), wolf: id(g, 'villager'), seer: id(g, 'wolf') });
  assert.equal(g.audit.length, 4);
  const publicView = viewGame(g, id(g, 'villager'));
  assert.equal(publicView.log.some(entry => entry.text.includes('复盘')), false);
  assert.equal(publicView.log.some(entry => entry.text.includes('查验')), false);
  vote(g, id(g, 'wolf'));
  const finishedView = viewGame(g, id(g, 'villager'));
  assert.equal(finishedView.phase, 'finished');
  assert.equal(finishedView.log.filter(entry => entry.text.includes('复盘')).length, 4);
  assert.equal(finishedView.log.some(entry => entry.text.includes('查验')), true);
  for (let i = 1; i < finishedView.log.length; i++) assert.ok(finishedView.log[i].at >= finishedView.log[i - 1].at);
});

test('reserved object-key player IDs cannot corrupt actions or investigations', () => {
  const players = ['wolf-id', 'villager-id', 'constructor', 'witch-id', 'hunter-id', '__proto__'].map((id, i) => ({ id, name: id, seat: i + 1 }));
  const g = createGame(players, SIX, { now: 1000, random: () => 0.999 });
  submit(g, '__proto__', { type: 'guard', targetId: 'villager-id' }, 1001);
  assert.equal(Object.hasOwn(g.actions, '__proto__'), true);
  advance(g, g.deadline);
  play(g, 'wolf'); play(g, 'seer', 'wolf-id');
  assert.equal(viewGame(g, 'constructor').privateInfo.results[0].team, 'wolf');
});
