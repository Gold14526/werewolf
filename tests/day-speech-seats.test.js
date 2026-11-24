import test from 'node:test';
import assert from 'node:assert/strict';
import { act, advance, createGame, viewGame } from '../web/engine.js';

const roster = Array.from({ length: 8 }, (_, i) => ({ id: 's' + (i + 1), seat: i + 1, name: '玩家' + (i + 1) }));

function game(sheriff = false, roles = { wolf: 1, villager: 7 }) {
  return createGame(roster, {
    roles, victory: 'all', daySeconds: 60, sheriff,
  }, { now: 1000, random: () => 0.999 });
}

function send(g, id, action) {
  return act(g, id, action, Math.min(g.deadline, g.inactivityDeadline ?? Infinity) - 1);
}

function night(g, victim = null, poisoned = null) {
  assert.equal(g.phase, 'night');
  const wolf = g.players.find(p => p.role === 'wolf');
  send(g, wolf.id, { type: 'wolf', targetId: victim && 's' + victim });
  advance(g, g.deadline);
  const witch = g.players.find(p => p.role === 'witch');
  if (witch) {
    send(g, witch.id, { type: 'witch', choice: poisoned ? 'poison' : 'skip', targetId: poisoned && 's' + poisoned });
    advance(g, g.deadline);
  }
}

function elect(g, seat) {
  assert.equal(g.phase, 'sheriff_signup');
  for (const p of roster) send(g, p.id, { type: 'sheriff_signup', choice: p.seat === seat ? 'join' : 'skip' });
  assert.equal(g.sheriffId, 's' + seat);
}

function passWords(g, seat) {
  assert.equal(g.phase, 'lastwords');
  assert.equal(g.currentSpeakerId, 's' + seat);
  send(g, g.currentSpeakerId, { type: 'pass' });
}

function takeSpeeches(g) {
  assert.equal(g.phase, 'discussion');
  const seats = [];
  while (g.phase === 'discussion') {
    assert.ok(seats.length < roster.length, 'at most one turn per seat');
    const id = g.currentSpeakerId;
    const speaker = viewGame(g, id);
    assert.equal(speaker.canSpeak, true);
    seats.push(speaker.players.find(p => p.id === id).seat);
    send(g, id, { type: 'pass' });
  }
  assert.equal(g.phase, 'vote');
  return seats;
}

function closeVote(g) {
  assert.equal(g.phase, 'vote');
  advance(g, g.deadline);
}

test('a single death starts at the next living seat across last words, restart, wraparound and later nights', () => {
  let g = game();
  night(g, 7);
  g = JSON.parse(JSON.stringify(g));
  passWords(g, 7);
  assert.deepEqual(takeSpeeches(g), [8, 1, 2, 3, 4, 5, 6]);
  closeVote(g);
  night(g, 6);
  assert.deepEqual(takeSpeeches(g), [8, 1, 2, 3, 4, 5]);
  closeVote(g);
  night(g);
  assert.deepEqual(takeSpeeches(g), [1, 2, 3, 4, 5, 8]);
});

test('after a single death speeches start with the sheriff’s nearest living neighbor in the chosen direction', () => {
  for (const [choice, sheriff, expected] of [
    ['left', 2, [1, 8, 7, 6, 4, 3, 2]],
    ['right', 2, [3, 4, 6, 7, 8, 1, 2]],
    ['left', 6, [4, 3, 2, 1, 8, 7, 6]],
    ['right', 4, [6, 7, 8, 1, 2, 3, 4]],
  ]) {
    let g = game(true);
    night(g, 5);
    elect(g, sheriff);
    passWords(g, 5);
    g = JSON.parse(JSON.stringify(g));
    assert.equal(g.phase, 'sheriff_direction');
    const direction = viewGame(g, g.sheriffId);
    assert.deepEqual(direction.action.choices, ['left', 'right']);
    send(g, g.sheriffId, { type: 'sheriff_direction', choice });
    assert.deepEqual(takeSpeeches(g), expected);
  }
});

test('peaceful nights retain ordinary seat order or direction from the sheriff', () => {
  const normal = game();
  night(normal);
  assert.deepEqual(takeSpeeches(normal), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const [choice, expected] of [
    ['left', [2, 1, 8, 7, 6, 5, 4, 3]],
    ['right', [4, 5, 6, 7, 8, 1, 2, 3]],
  ]) {
    const g = game(true);
    night(g);
    elect(g, 3);
    send(g, g.sheriffId, { type: 'sheriff_direction', choice });
    assert.deepEqual(takeSpeeches(g), expected);
  }
});

test('the preceding night’s death and the sheriff’s direction never add speakers to a runoff', () => {
  const g = game(true);
  night(g, 5);
  elect(g, 6);
  passWords(g, 5);
  send(g, g.sheriffId, { type: 'sheriff_direction', choice: 'right' });
  takeSpeeches(g);
  send(g, 's1', { type: 'vote', targetId: 's2' });
  send(g, 's3', { type: 'vote', targetId: 's4' });
  closeVote(g);
  assert.equal(g.runoff, true);
  const speakers = takeSpeeches(g);
  assert.equal(speakers.length, 2);
  assert.deepEqual(new Set(speakers), new Set([2, 4]));
});

test('multiple deaths anchor at the lowest dead seat without a sheriff and at the sheriff otherwise', () => {
  for (const sheriff of [false, true]) for (const [attacked, poisoned] of [[7, 3], [3, 7]]) {
    const g = game(sheriff, { wolf: 1, villager: 6, witch: 1 });
    night(g, attacked, poisoned);
    if (sheriff) elect(g, 5);
    const deaths = [];
    while (g.phase === 'lastwords') {
      deaths.push(g.currentSpeakerId);
      send(g, g.currentSpeakerId, { type: 'pass' });
    }
    assert.deepEqual(new Set(deaths), new Set(['s3', 's7']));
    if (sheriff) {
      send(g, g.sheriffId, { type: 'sheriff_direction', choice: 'right' });
      assert.deepEqual(takeSpeeches(g), [6, 8, 1, 2, 4, 5]);
    } else {
      assert.deepEqual(takeSpeeches(g), [4, 5, 6, 8, 1, 2]);
    }
  }
});

test('after a badge transfer the new sheriff chooses from their own neighbors and speaks last', () => {
  const g = game(true);
  night(g, 5);
  elect(g, 5);
  assert.equal(g.phase, 'sheriff_transfer');
  send(g, 's5', { type: 'sheriff_transfer', targetId: 's2' });
  passWords(g, 5);
  assert.equal(g.sheriffId, 's2');
  assert.equal(viewGame(g, 's2').action.type, 'sheriff_direction');
  send(g, 's2', { type: 'sheriff_direction', choice: 'right' });
  assert.deepEqual(takeSpeeches(g), [3, 4, 6, 7, 8, 1, 2]);
});
