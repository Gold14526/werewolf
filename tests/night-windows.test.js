import test from 'node:test';
import assert from 'node:assert/strict';
import { act, advance, canChat, createGame, migrateNightConfig, validateConfig, viewGame } from '../web/engine.js';

const roster = Array.from({ length: 7 }, (_, i) => ({ id: 'p' + i, name: '玩家' + i, seat: i + 1 }));
const config = { roles: { wolf: 2, guard: 1, seer: 1, witch: 1, villager: 2 }, victory: 'all', nightSeconds: 75 };
const game = (changes = {}) => createGame(roster, { ...config, ...changes }, { now: 1000, random: () => 0.99 });
const member = (g, role) => g.players.find(p => p.role === role);
const view = (g, role) => viewGame(g, member(g, role).id);
const choose = (g, role, targetId, at, choice) => act(g, member(g, role).id, { type: role, targetId, choice }, at);

test('parallel night has independent fixed windows and a single public deadline', () => {
  const g = game({ otherNightSeconds: 40 });
  const villager = member(g, 'villager');
  assert.equal(view(g, 'wolf').action.deadline, 76000);
  assert.equal(view(g, 'guard').action.deadline, 41000);
  assert.equal(view(g, 'seer').action.deadline, 41000);
  assert.equal(view(g, 'witch').actionable, false);
  choose(g, 'guard', villager.id, 1100);
  choose(g, 'seer', member(g, 'wolf').id, 1100);
  assert.deepEqual(view(g, 'wolf').privateInfo.wolfVotes, []);
  for (const now of [1100, 41000, 75000, 76000, 115999]) {
    advance(g, now);
    const v = view(g, 'villager');
    assert.equal(v.phase, 'night');
    assert.equal(v.deadline, 116000);
    assert.equal(v.action, null);
    assert.deepEqual(v.privateInfo, {});
    if (now === 41000) {
      assert.equal(view(g, 'seer').privateInfo.results[0].team, 'wolf');
      assert.equal(g.night.guard, villager.id);
      choose(g, 'wolf', villager.id, 41001);
    }
  }
  assert.equal(view(g, 'witch').privateInfo.nightVictim.id, villager.id);
  assert.equal(canChat(g, member(g, 'wolf').id, 'wolf'), false);
  assert.throws(() => choose(g, 'witch', null, 115999, 'save'));
  assert.throws(() => choose(g, 'witch', member(g, 'guard').id, 115999, 'save'));
  choose(g, 'witch', villager.id, 115999, 'save');
  advance(g, 116000);
  assert.equal(g.potions.save, false);
  assert.equal(villager.alive, false, 'guard protection plus antidote still kills');
});

test('tied or empty wolf votes show no victim and allow poison on any living seat', () => {
  for (const tie of [false, true]) {
    const g = game(), wolves = g.players.filter(p => p.role === 'wolf');
    if (tie) {
      act(g, wolves[0].id, { type: 'wolf', targetId: member(g, 'seer').id }, 2000);
      act(g, wolves[1].id, { type: 'wolf', targetId: member(g, 'guard').id }, 2000);
    }
    advance(g, 76000);
    const witch = view(g, 'witch');
    assert.equal(witch.privateInfo.nightVictim, null);
    assert.deepEqual(witch.action.choices, ['skip', 'poison']);
    assert.deepEqual(new Set(witch.action.targets.map(p => p.id)), new Set(g.players.map(p => p.id)));
    choose(g, 'witch', member(g, 'witch').id, 76001, 'poison');
    advance(g, 106000);
    assert.equal(member(g, 'witch').alive, false);
  }
});

test('all three self-save policies apply to the first and later nights', () => {
  assert.equal(validateConfig(config).witchSelfSave, 'first');
  for (const policy of ['none', 'first', 'always']) for (const round of [1, 2]) {
    const g = game({ witchSelfSave: policy }); g.round = round;
    const witch = member(g, 'witch');
    choose(g, 'wolf', witch.id, 1100);
    advance(g, 76000);
    const permitted = policy === 'always' || (policy === 'first' && round === 1);
    assert.equal(view(g, 'witch').action.choices.includes('save'), permitted);
    if (permitted) choose(g, 'witch', witch.id, 77000, 'save');
    else assert.throws(() => choose(g, 'witch', witch.id, 77000, 'save'));
    advance(g, 106000);
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
    advance(reloaded, publicEnd + 8000);
    assert.notEqual(reloaded.phase, 'night');
    if (role === 'witch') {
      assert.equal(reloaded.potions.save, false);
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
  advance(g, view(g, 'villager').deadline);
  assert.equal(g.phase, 'sheriff_signup');
  assert.equal(g.deadline, 156000);
  const old = game();
  old.phase = 'vote'; old.deadline = 76000; delete old.config.otherNightSeconds;
  assert.equal(migrateNightConfig(old, 11000), true);
  assert.equal(old.deadline, 31000);
  assert.equal(migrateNightConfig(old, 12000), false);
  assert.equal(old.deadline, 31000);
});
