import test from 'node:test';
import assert from 'node:assert/strict';
import { act, advance, canChat, createGame, migrateNightConfig, validateConfig, viewGame } from '../web/engine.js';

const roster = Array.from({ length: 7 }, (_, i) => ({ id: 'p' + i, name: '玩家' + i, seat: i + 1 }));
const config = { roles: { wolf: 2, guard: 1, seer: 1, witch: 1, villager: 2 }, victory: 'all', nightSeconds: 75 };
const game = (changes = {}) => createGame(roster, { ...config, ...changes }, { now: 1000, random: () => 0.99 });
const member = (g, role) => g.players.find(p => p.role === role);
const view = (g, role) => viewGame(g, member(g, role).id);
const choose = (g, role, targetId, at, choice) => act(g, member(g, role).id, { type: role, targetId, choice }, at);

const stageLabels = { guard: '守卫行动', wolf: '狼人行动', seer: '预言家行动', witch: '女巫行动' };

function stage(type, deadline) {
  return { type, label: stageLabels[type], deadline };
}

test('night roles act in order with the current role and its deadline public', () => {
  const g = game({ otherNightSeconds: 40 });
  const villager = member(g, 'villager');
  const stages = [
    ['guard', 1000, 41000], ['wolf', 41000, 116000],
    ['seer', 116000, 156000], ['witch', 156000, 196000],
  ];
  for (const [role, start, end] of stages) {
    advance(g, start);
    for (const [candidate] of stages) assert.equal(view(g, candidate).actionable, candidate === role);
    assert.equal(view(g, role).action.deadline, end);
    assert.equal(canChat(g, member(g, 'wolf').id, 'wolf'), role === 'wolf');
    if (role === 'witch') {
      assert.equal(view(g, 'seer').privateInfo.results[0].team, 'wolf');
      assert.equal(view(g, role).privateInfo.nightVictim.id, villager.id);
      assert.throws(() => choose(g, role, null, start + 1, 'save'));
      assert.throws(() => choose(g, role, member(g, 'guard').id, start + 1, 'save'));
      choose(g, role, villager.id, start + 1, 'save');
    } else {
      const target = role === 'seer' ? member(g, 'wolf').id : villager.id;
      choose(g, role, target, start + 1);
    }
    advance(g, end - 1);
    const v = view(g, 'villager');
    assert.equal(v.phase, 'night');
    assert.equal(v.deadline, end);
    assert.equal(v.phaseLabel, stageLabels[role]);
    assert.deepEqual(v.nightStages, [stage(role, end)]);
    const observer = viewGame(g, null);
    assert.deepEqual(observer.nightStages, v.nightStages);
    assert.equal(observer.deadline, end);
    assert.equal(observer.action, null);
    assert.deepEqual(observer.privateInfo, {});
    assert.equal(v.action, null);
    assert.deepEqual(v.privateInfo, {});
  }
  advance(g, 196000);
  assert.equal(view(g, 'witch').privateInfo.potions.save, false);
  assert.equal(villager.alive, false, 'guard protection plus antidote still kills');
});

test('a persisted parallel night completes as scheduled, then starts the next night in order', () => {
  const snapshot = game();
  delete snapshot.night.sequential;
  snapshot.night.windows = [
    { role: 'guard', offset: 0 }, { role: 'seer', offset: 0 },
    { role: 'wolf', offset: 45000 }, { role: 'witch', offset: 75000 },
  ];
  const victim = member(snapshot, 'villager').id;
  choose(snapshot, 'wolf', victim, 5000);
  choose(snapshot, 'seer', victim, 5000);
  const g = JSON.parse(JSON.stringify(snapshot));
  advance(g, 20000);
  const watching = viewGame(g, null);
  assert.deepEqual(watching.nightStages, [stage('guard', 31000), stage('wolf', 76000), stage('seer', 31000)]);
  assert.equal(watching.phaseLabel, '守卫行动、狼人行动、预言家行动');
  assert.equal(watching.deadline, 31000);
  assert.equal(watching.action, null);
  assert.deepEqual(watching.privateInfo, {});
  assert.equal(view(g, 'wolf').action.deadline, 76000);
  assert.equal(view(g, 'guard').actionable, true);
  assert.equal(view(g, 'wolf').submitted, true);
  assert.equal(view(g, 'seer').submitted, true);
  advance(g, 31000);
  assert.deepEqual(viewGame(g, null).nightStages, [stage('wolf', 76000)]);
  assert.equal(view(g, 'seer').privateInfo.results[0].id, victim);
  advance(g, 76000);
  assert.deepEqual(viewGame(g, null).nightStages, [stage('witch', 106000)]);
  assert.equal(view(g, 'witch').privateInfo.nightVictim.id, victim);
  choose(g, 'witch', victim, 76001, 'save');
  advance(g, 106000);
  assert.deepEqual(viewGame(g, null).nightStages, []);
  while (g.currentSpeakerId) act(g, g.currentSpeakerId, { type: 'pass' }, 106001);
  advance(g, g.deadline);
  assert.equal(g.round, 2);
  assert.equal(view(g, 'guard').actionable, true);
  assert.equal(view(g, 'wolf').actionable, false);
  assert.equal(view(g, 'seer').actionable, false);
});

test('tied or empty wolf votes show no victim and allow poison on any living seat', () => {
  for (const tie of [false, true]) {
    const g = game(), wolves = g.players.filter(p => p.role === 'wolf');
    advance(g, 31000);
    if (tie) {
      act(g, wolves[0].id, { type: 'wolf', targetId: member(g, 'seer').id }, 32000);
      act(g, wolves[1].id, { type: 'wolf', targetId: member(g, 'guard').id }, 32000);
    }
    advance(g, 136000);
    const witch = view(g, 'witch');
    assert.equal(witch.privateInfo.nightVictim, null);
    assert.deepEqual(witch.action.choices, ['skip', 'poison']);
    assert.deepEqual(new Set(witch.action.targets.map(p => p.id)), new Set(g.players.map(p => p.id)));
    choose(g, 'witch', member(g, 'witch').id, 136001, 'poison');
    advance(g, 166000);
    assert.equal(member(g, 'witch').alive, false);
  }
});

test('all three self-save policies apply to the first and later nights', () => {
  assert.equal(validateConfig(config).witchSelfSave, 'first');
  for (const policy of ['none', 'first', 'always']) for (const round of [1, 2]) {
    const g = game({ witchSelfSave: policy }); g.round = round;
    const witch = member(g, 'witch');
    choose(g, 'wolf', witch.id, 31001);
    advance(g, 136000);
    const permitted = policy === 'always' || (policy === 'first' && round === 1);
    assert.equal(view(g, 'witch').action.choices.includes('save'), permitted);
    if (permitted) choose(g, 'witch', witch.id, 137000, 'save');
    else assert.throws(() => choose(g, 'witch', witch.id, 137000, 'save'));
    advance(g, 166000);
    assert.equal(witch.alive, permitted);
  }
  assert.throws(() => validateConfig({ ...config, otherNightSeconds: 75 }));
  assert.throws(() => validateConfig({ ...config, witchSelfSave: true }));
});

test('old night upgrades in place using elapsed time, preserves submitted actions and resumes once', () => {
  for (const role of ['guard', 'wolf', 'seer', 'witch']) {
    const g = game(), witch = member(g, 'witch'), victim = member(g, 'villager');
    g.phase = role; g.deadline = 76000; delete g.night.windows;
    delete g.config.otherNightSeconds; delete g.config.shuffleSeats; delete g.config.witchSelfSave;
    g.night.victim = ['seer', 'witch'].includes(role) ? victim.id : null;
    if (role === 'witch') g.actions[witch.id] = { choice: 'save', targetId: null };
    const before = g.players.map(p => [p.id, p.seat, p.role]);
    assert.equal(migrateNightConfig(g, 11000), true);
    assert.deepEqual(g.players.map(p => [p.id, p.seat, p.role]), before);
    assert.equal(g.config.shuffleSeats, false);
    assert.equal(g.config.otherNightSeconds, 30);
    assert.equal(g.config.nightSeconds, 75);
    assert.deepEqual(viewGame(g, null).nightStages, [stage(role, role === 'wolf' ? 76000 : 31000)]);
    assert.equal(g.config.witchSelfSave, 'first');
    assert.equal(migrateNightConfig(g, 12000), false);
    if (role === 'witch') {
      assert.equal(g.actions[witch.id].targetId, victim.id);
      assert.equal(g.deadline, 31000);
    } else {
      const expected = role === 'wolf' ? 76000 : 31000;
      assert.equal(view(g, role).action.deadline, expected);
    }
    const publicEnd = view(g, 'villager').deadline;
    const reloaded = JSON.parse(JSON.stringify(g));
    reloaded.deadline += 8000;
    assert.equal(view(reloaded, 'villager').deadline, publicEnd + 8000);
    const order = ['guard', 'wolf', 'seer', 'witch'];
    for (const expected of order.slice(order.indexOf(role))) {
      const current = viewGame(reloaded, null);
      assert.deepEqual(current.nightStages, [stage(expected, current.deadline)]);
      advance(reloaded, current.deadline);
    }
    assert.notEqual(reloaded.phase, 'night');
    if (role === 'witch') {
      assert.equal(view(reloaded, 'witch').privateInfo.potions.save, false);
      assert.equal(member(reloaded, 'villager').alive, true);
    }
  }
});

test('optional opening seat shuffle preserves all players and roles without changing lobby input', () => {
  const original = structuredClone(roster);
  const games = [false, true].map(shuffleSeats => createGame(roster, { ...config, shuffleSeats }, { now: 1, random: () => 0 }));
  assert.deepEqual(games[0].players.map(p => p.id), roster.map(p => p.id));
  const shuffled = games[1].players;
  assert.notDeepEqual(shuffled.map(p => p.id), roster.map(p => p.id));
  assert.deepEqual(shuffled.map(p => p.seat), roster.map(p => p.seat));
  assert.deepEqual(new Set(shuffled.map(p => p.id)), new Set(roster.map(p => p.id)));
  assert.deepEqual(roster, original);
  assert.throws(() => validateConfig({ ...config, shuffleSeats: 'true' }));
});

test('the other action duration covers non-speech daytime actions and migrates old votes once', () => {
  const g = game({ otherNightSeconds: 40, sheriff: true });
  while (g.phase === 'night') advance(g, view(g, 'villager').deadline);
  assert.equal(g.phase, 'sheriff_signup');
  assert.equal(g.deadline, 236000);
  const old = game();
  old.phase = 'vote'; old.deadline = 76000; delete old.config.otherNightSeconds;
  assert.equal(migrateNightConfig(old, 11000), true);
  assert.equal(old.deadline, 31000);
  assert.equal(migrateNightConfig(old, 12000), false);
  assert.equal(old.deadline, 31000);
});

test('every wolf and other timer setting gives all seats and observers the exact current interval', () => {
  for (const nightSeconds of [60, 75, 90]) for (const otherNightSeconds of [30, 40, 50]) {
    const g = game({ nightSeconds, otherNightSeconds });
    let end = 1000;
    for (const role of ['guard', 'wolf', 'seer', 'witch']) {
      end += 1000 * (role === 'wolf' ? nightSeconds : otherNightSeconds);
      for (const id of [null, ...g.players.map(p => p.id)]) {
        const v = viewGame(g, id);
        assert.equal(v.deadline, end);
        assert.deepEqual(v.nightStages, [stage(role, end)]);
        assert.equal(v.phaseLabel, stageLabels[role]);
      }
      advance(g, end - 1);
      assert.equal(viewGame(g, null).deadline, end);
      advance(g, end);
    }
    assert.equal(g.phase, 'discussion');
    assert.deepEqual(viewGame(g, null).nightStages, []);
  }
});

test('only configured stages appear, even if everyone with that role has died', () => {
  const g = game({ roles: { wolfKing: 1, seer: 1, villager: 5 } });
  const seer = member(g, 'seer');
  seer.alive = false;
  assert.deepEqual(viewGame(g, null).nightStages, [stage('wolf', 76000)]);
  advance(g, 76000);
  assert.deepEqual(viewGame(g, null).nightStages, [stage('seer', 106000)]);
  for (const p of g.players) assert.equal(viewGame(g, p.id).action, null);
  advance(g, 106000);
  assert.equal(g.phase, 'discussion');
  assert.deepEqual(viewGame(g, null).nightStages, []);
});
