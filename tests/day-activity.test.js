import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, act, advance, viewGame } from '../web/engine.js';

const people = Array.from({ length: 6 }, (_, index) => ({ id: 'p' + index, name: '玩家' + index }));

function room(options = {}) {
  const game = createGame(people, {
    roles: { wolf: 1, villager: 4, seer: 1 },
    daySeconds: 90, victory: 'all', ...options,
  }, { now: 1000, random: () => .99 });
  while (game.phase === 'night') advance(game, game.deadline);
  return game;
}

function endSpeeches(game, time) {
  while (['lastwords', 'discussion', 'sheriff_speech'].includes(game.phase)) {
    act(game, game.currentSpeakerId, { type: 'pass', turnDeadline: game.deadline }, time++);
  }
}

test('only genuine speaker input extends the idle clock, with a private 15 second warning window', () => {
  const game = room(), [first, next] = people;
  assert.equal(game.currentSpeakerId, first.id);
  const start = game.deadline - 90_000;
  const idle = viewGame(game, first.id).inactivityDeadline;
  assert.equal(idle, start + 60_000);
  assert.equal(viewGame(game, next.id).inactivityDeadline, null);
  assert.equal(viewGame(game, null).inactivityDeadline, null);
  assert.throws(() => act(game, next.id, { type: 'typing' }, start + 10_000));
  advance(game, idle - 15_000);
  assert.equal(viewGame(game, first.id).inactivityDeadline, idle);
  act(game, first.id, { type: 'typing', turnDeadline: game.deadline }, start + 15_250);
  const newIdle = idle + 15_250;
  assert.equal(viewGame(game, first.id).inactivityDeadline, newIdle);
  advance(game, newIdle - 1);
  assert.equal(game.currentSpeakerId, first.id);
  advance(game, newIdle);
  assert.equal(game.currentSpeakerId, next.id);
  assert.equal(viewGame(game, first.id).myAfk, true);
  for (const observer of [first.id, next.id, null]) {
    const seat = viewGame(game, observer).players.find(p => p.id === first.id);
    assert.equal(seat.alive, true);
    assert.equal(seat.afk, true);
    assert.equal(seat.publicRole, undefined);
  }
  assert.throws(() => act(game, first.id, { type: 'typing' }, newIdle + 1));
});

test('speaking before the end of the turn avoids AFK even if a late poll sees both deadlines pass', () => {
  const game = room(), id = game.currentSpeakerId;
  const start = game.deadline - 90_000;
  act(game, id, { type: 'typing' }, start + 50_000);
  assert.equal(viewGame(game, id).inactivityDeadline, null);
  advance(game, start + 200_000);
  assert.equal(viewGame(game, id).myAfk, false);
  assert.notEqual(game.currentSpeakerId, id);
});

test('AFK persists through a new round and JSON reload, and return restores normal speaking time', () => {
  let game = room();
  const first = game.currentSpeakerId;
  const at = game.inactivityDeadline;
  advance(game, at);
  game = JSON.parse(JSON.stringify(game));
  assert.equal(viewGame(game, first).myAfk, true);
  endSpeeches(game, at + 1);
  assert.equal(game.phase, 'vote');
  advance(game, game.deadline);
  let nightEnd;
  while (game.phase === 'night') { nightEnd = game.deadline; advance(game, nightEnd); }
  assert.equal(game.currentSpeakerId, first);
  assert.equal(game.deadline, nightEnd + 2000);
  act(game, first, { type: 'typing' }, nightEnd + 500);
  assert.equal(viewGame(game, first).myAfk, true);
  act(game, first, { type: 'return' }, nightEnd + 1000);
  assert.equal(viewGame(game, first).myAfk, false);
  assert.equal(viewGame(game, null).players.find(p => p.id === first).afk, false);
  assert.equal(game.deadline, nightEnd + 1000 + 90_000);
  assert.equal(viewGame(game, first).inactivityDeadline, nightEnd + 1000 + 60_000);
});

test('all surviving participants AFK draw, but an existing faction victory takes precedence', () => {
  for (const expected of ['draw', 'good', 'wolf']) {
    const game = room();
    const speaker = game.players[0], wolf = game.players.find(p => p.role === 'wolf');
    if (expected === 'good') {
      wolf.alive = false;
      game.speechQueue = game.speechQueue.filter(id => id !== wolf.id);
      game.currentSpeakerId = game.speechQueue[0];
    }
    if (expected === 'wolf') {
      assert.equal(wolf, speaker);
      game.players.filter(p => p !== wolf).forEach(p => { p.alive = false; });
    }
    const id = game.currentSpeakerId;
    for (const p of game.players) p.afk = p.alive && p.id !== id;
    advance(game, game.inactivityDeadline);
    assert.equal(game.winner, expected);
    assert.equal(game.phase, 'finished');
  }
});

test('every ballot remains editable including abstention after all electors vote', () => {
  for (const phase of ['vote', 'sheriff_vote']) {
    const game = room({ sheriff: phase === 'sheriff_vote' });
    if (game.phase === 'sheriff_signup') {
      const now = game.deadline - 500;
      for (const [i, p] of people.entries()) act(game, p.id, { type: 'sheriff_signup', choice: i < 2 ? 'join' : 'skip' }, now);
    }
    endSpeeches(game, game.deadline - 89_000);
    assert.equal(game.phase, phase);
    const deadline = game.deadline, voter = people[3].id;
    for (const p of people) if (viewGame(game, p.id).actionable) {
      act(game, p.id, { type: phase, targetId: null, turnDeadline: deadline }, deadline - 400);
    }
    assert.equal(game.phase, phase);
    assert.equal(viewGame(game, voter).submitted, true);
    for (const targetId of [people[0].id, people[1].id, null, people[1].id]) {
      act(game, voter, { type: phase, targetId, turnDeadline: deadline }, deadline - 50);
      assert.equal(viewGame(game, voter).myVoteTargetId, targetId);
      assert.equal(viewGame(game, voter).actionable, true);
      assert.equal(viewGame(game, null).myVoteTargetId, null);
    }
    assert.throws(() => act(game, voter, { type: phase, targetId: null, turnDeadline: deadline - 1 }, deadline - 1));
    advance(game, deadline);
    if (phase === 'vote') assert.equal(game.players[1].alive, false);
    else assert.equal(game.sheriffId, people[1].id);
  }
});

test('an old in-progress speech starts input tracking when loaded without punishing earlier silence', () => {
  const game = room(), id = game.currentSpeakerId;
  const loadedAt = game.deadline - 20_000;
  delete game.inactivityDeadline;
  advance(game, loadedAt);
  assert.equal(game.inactivityDeadline, loadedAt + 60_000);
  advance(game, game.deadline);
  assert.equal(viewGame(game, id).myAfk, false);
});

test('sheriff speeches and tied exile speeches both enforce speaker inactivity and automatic 2s passes', () => {
  for (const type of ['sheriff_speech', 'discussion']) {
    const game = room({ sheriff: type === 'sheriff_speech' });
    const [a, b] = people;
    if (type === 'sheriff_speech') {
      for (const p of people) act(game, p.id, { type: 'sheriff_signup', choice: [a,b].includes(p) ? 'join' : 'skip' }, game.deadline - 1);
    } else {
      endSpeeches(game, game.deadline - 89_000);
      act(game, people[2].id, { type: 'vote', targetId: a.id }, game.deadline - 1);
      act(game, people[3].id, { type: 'vote', targetId: b.id }, game.deadline - 1);
      advance(game, game.deadline);
      assert.equal(game.runoff, true);
    }
    assert.equal(game.phase, type);
    assert.equal(game.currentSpeakerId, a.id);
    game.players.find(p => p.id === b.id).afk = true;
    const due = game.inactivityDeadline;
    advance(game, due);
    assert.equal(game.currentSpeakerId, b.id);
    assert.equal(game.deadline, due + 2000);
    advance(game, due + 1999);
    assert.equal(game.currentSpeakerId, b.id);
    advance(game, due + 2000);
    assert.equal(game.phase, type === 'sheriff_speech' ? 'sheriff_vote' : 'vote');
  }
});

test('a wolf poisoned before the election loses even if every candidate then goes AFK', () => {
  const game = createGame(people, {
    roles: { wolf: 1, villager: 4, witch: 1 }, daySeconds: 60, victory: 'all', sheriff: true,
  }, { now: 1000, random: () => .99 });
  const wolf = game.players.find(p => p.role === 'wolf'), witch = game.players.find(p => p.role === 'witch');
  while (game.phase === 'night') {
    if (viewGame(game, witch.id).action?.type === 'witch') {
      act(game, witch.id, { type: 'witch', choice: 'poison', targetId: wolf.id }, game.deadline - 1);
    }
    advance(game, game.deadline);
  }
  for (const p of people) act(game, p.id, { type: 'sheriff_signup', choice: 'join' }, game.deadline - 1);
  while (game.phase === 'sheriff_speech') advance(game, game.inactivityDeadline);
  assert.equal(wolf.alive, false);
  while (game.phase === 'lastwords') advance(game, game.deadline);
  assert.equal(game.winner, 'good');
});
