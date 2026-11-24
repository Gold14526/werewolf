import assert from "node:assert/strict";
import test from "node:test";
import { act, advance, createGame, migrateNightConfig, validateConfig, viewGame } from "../web/engine.js";

const deck = { wolf: 1, villager: 2, guard: 2, seer: 2, witch: 2, hunter: 2, fool: 2, knight: 2 };

function game(options = {}) {
  const players = Array.from({ length: Object.values(deck).reduce((a, b) => a + b, 0) }, (_, i) => ({ id: "p" + i, name: "玩家" + i }));
  return createGame(players, { roles: deck, victory: "all", ...options }, { now: 1000, random: () => 0.99 });
}
const role = (g, r) => g.players.filter((p) => p.role === r);
const view = (g, p) => viewGame(g, p.id);
function choose(g, p, target = null, choice) {
  const v = view(g, p);
  return act(g, p.id, { type: v.action.type, round: v.round, turnDeadline: v.action.deadline, targetId: target?.id ?? null, choice }, g.deadline - 1);
}

function finishDay(g) {
  while (g.phase === "discussion" || g.phase === "lastwords") {
    act(g, g.currentSpeakerId, { type: "pass" }, g.deadline - g.config.daySeconds * 1000 + 1);
  }
  assert.equal(g.phase, "vote");
  advance(g, g.deadline);
}

test("only the two special wolf roles remain limited to one; total and balance limits still apply", () => {
  const g = game();
  for (const [r, count] of Object.entries(deck)) assert.equal(role(g, r).length, count);
  for (const key of ["wolfKing", "whiteWolfKing"]) assert.throws(() => validateConfig({ roles: { ...deck, [key]: 2 } }));
  assert.throws(() => validateConfig({ roles: { ...deck, seer: 6 } }));
  assert.throws(() => validateConfig({ roles: { wolf: 3, guard: 2, villager: 1 } }));
});

test("each guard locks their final selection, then only their own preceding target is forbidden", () => {
  const g = game();
  const [a, b] = role(g, "guard"), [x, y] = role(g, "villager"), [wolf] = role(g, "wolf");
  choose(g, a, x);
  choose(g, a);
  choose(g, a, y);
  choose(g, b, x);
  assert.deepEqual(view(g, a).action.selected, { targetId: y.id });
  assert.deepEqual(view(g, b).action.selected, { targetId: x.id });
  assert(!("selected" in (viewGame(g, null).action ?? {})));
  advance(g, g.deadline);
  choose(g, wolf, x);
  while (g.phase === "night") advance(g, g.deadline);
  assert(x.alive);
  finishDay(g);
  assert(!view(g, a).action.targets.some((p) => p.id === y.id));
  assert(!view(g, b).action.targets.some((p) => p.id === x.id));
  choose(g, a, x);
  choose(g, b, y);
});

test("each seer receives one private final result; retries, wrong round and stale role deadlines cannot replace it", () => {
  let g = game();
  const [a, b] = role(g, "seer"), [wolf] = role(g, "wolf"), [villager] = role(g, "villager");
  advance(g, g.deadline);
  choose(g, wolf, villager);
  choose(g, wolf);
  choose(g, wolf, villager);
  advance(g, g.deadline);
  const first = view(g, a);
  choose(g, a, villager);
  choose(g, b, villager);
  choose(g, a, wolf);
  assert.throws(() => act(g, a.id, { type: "seer", round: 2, targetId: villager.id }, g.deadline - 1));
  assert.throws(() => act(g, a.id, { type: "seer", turnDeadline: g.deadline - 1, targetId: villager.id }, g.deadline - 1));
  g = JSON.parse(JSON.stringify(g));
  assert.deepEqual(view(g, a).privateInfo.results, []);
  assert.deepEqual(view(g, b).action.selected, { targetId: villager.id });
  advance(g, g.deadline);
  assert.deepEqual(view(g, a).privateInfo.results.map((p) => p.id), [wolf.id]);
  assert.deepEqual(view(g, b).privateInfo.results.map((p) => p.id), [villager.id]);
  assert.equal(viewGame(g, null).privateInfo.results, undefined);
  assert.throws(() => act(g, a.id, { type: "seer", round: first.round, turnDeadline: first.action.deadline, targetId: villager.id }, g.deadline - 1));
});

test("witches spend independent potions only at the deadline; poison overrides hunter guns and duplicate deaths", () => {
  for (const sameTarget of [false, true]) {
    let g = game();
    const [w1, w2] = role(g, "witch"), [h1, h2] = role(g, "hunter"), [wolf] = role(g, "wolf");
    advance(g, g.deadline);
    choose(g, wolf, h1);
    advance(g, g.deadline);
    advance(g, g.deadline);
    choose(g, w1, h1, "save");
    choose(g, w1, null, "skip");
    choose(g, w1, h1, "poison");
    choose(g, w2, sameTarget ? h1 : h2, "poison");
    assert.deepEqual(view(g, w1).privateInfo.potions, { save: true, poison: true });
    assert.deepEqual(view(g, w1).action.selected, { choice: "poison", targetId: h1.id });
    g = JSON.parse(JSON.stringify(g));
    advance(g, g.deadline);
    assert.equal(g.players.find((p) => p.id === h1.id).alive, false);
    assert.equal(g.players.find((p) => p.id === h2.id).alive, sameTarget);
    assert.deepEqual(g.pendingHunters, []);
    assert.deepEqual(new Set(g.lastWordsQueue), new Set(sameTarget ? [h1.id] : [h1.id, h2.id]));
    assert.equal(g.lastWordsQueue.length, sameTarget ? 1 : 2);
    for (const w of [w1, w2]) assert.deepEqual(view(g, w).privateInfo.potions, { save: true, poison: false });
  }
});

test("one witch may rescue the other under no-self-save rules without consuming the victim’s bottle", () => {
  const g = game({ witchSelfSave: "none" });
  const [a, b] = role(g, "witch"), [wolf] = role(g, "wolf");
  advance(g, g.deadline);
  choose(g, wolf, a);
  advance(g, g.deadline);
  advance(g, g.deadline);
  assert(!view(g, a).action.choices.includes("save"));
  assert(view(g, b).action.choices.includes("save"));
  assert.throws(() => choose(g, a, a, "save"));
  choose(g, b, a, "save");
  advance(g, g.deadline);
  assert(a.alive);
  assert.deepEqual(view(g, a).privateInfo.potions, { save: true, poison: true });
  assert.deepEqual(view(g, b).privateInfo.potions, { save: false, poison: true });
});

test("several shields or antidotes count once per type; combined protection and rescue still kill", () => {
  for (const guarded of [false, true]) {
    const g = game();
    const [victim] = role(g, "villager"), [wolf] = role(g, "wolf");
    if (guarded) for (const guard of role(g, "guard")) choose(g, guard, victim);
    advance(g, g.deadline);
    choose(g, wolf, victim);
    advance(g, g.deadline);
    advance(g, g.deadline);
    for (const witch of role(g, "witch")) choose(g, witch, victim, "save");
    advance(g, g.deadline);
    assert.equal(victim.alive, !guarded);
    for (const witch of role(g, "witch")) assert.equal(view(g, witch).privateInfo.potions.save, false);
  }
});

test("legacy single-role inventories and already-settled scalar night results survive JSON recovery", () => {
  const old = game();
  old.players = old.players.filter((p, i, a2) => !["guard", "witch"].includes(p.role) || a2.find((x) => x.role === p.role) === p);
  old.config.roles.guard = old.config.roles.witch = 1;
  const [guard] = role(old, "guard"), [witch] = role(old, "witch"), [a, b] = role(old, "villager");
  delete guard.previousGuard;
  delete witch.potions;
  old.previousGuard = b.id;
  old.potions = { save: false, poison: true };
  const g = JSON.parse(JSON.stringify(old));
  assert.equal(migrateNightConfig(g, 1001), true);
  assert.equal(migrateNightConfig(g, 1002), false);
  assert.equal(view(g, guard).action.targets.some((p) => p.id === b.id), false);
  assert.deepEqual(view(g, witch).privateInfo.potions, { save: false, poison: true });
  g.config.sheriff = true;
  while (g.phase === "night") advance(g, g.deadline);
  assert.equal(g.phase, "sheriff_signup");
  g.night = { guard: a.id, victim: a.id, saved: false, poison: b.id };
  advance(g, g.deadline);
  assert(g.players.find((p) => p.id === a.id).alive);
  assert.equal(g.players.find((p) => p.id === b.id).alive, false);
});

test("each knight, fool and hunter keeps their own daytime power", () => {
  const g = game();
  const [firstKnight, secondKnight] = role(g, "knight");
  const [firstFool, secondFool] = role(g, "fool");
  const [firstHunter, secondHunter] = role(g, "hunter");
  const [villager] = role(g, "villager");
  const dawn = () => {
    while (g.phase === "night") advance(g, g.deadline);
  };
  const exile = target => {
    while (g.phase === "discussion") {
      act(g, g.currentSpeakerId, { type: "pass" }, g.deadline - g.config.daySeconds * 1000 + 1);
    }
    const voter = role(g, "wolf")[0];
    act(g, voter.id, { type: "vote", targetId: target.id }, g.deadline - 1);
    advance(g, g.deadline);
  };

  dawn();
  act(g, firstKnight.id, { type: "duel", targetId: villager.id }, g.deadline - g.config.daySeconds * 1000 + 1);
  assert(firstKnight.revealed);
  assert(view(g, secondKnight).canDuel);
  act(g, secondKnight.id, { type: "duel", targetId: villager.id }, g.deadline - g.config.daySeconds * 1000 + 1);
  assert.deepEqual(g.knightUsed, [firstKnight.id, secondKnight.id]);

  exile(firstFool);
  assert(firstFool.foolRevealed);
  assert(!secondFool.foolRevealed);
  dawn();
  exile(secondFool);
  assert(firstFool.alive && secondFool.alive && secondFool.foolRevealed);

  dawn();
  exile(firstHunter);
  assert.equal(view(g, firstHunter).action.type, "hunter");
  act(g, firstHunter.id, { type: "hunter", targetId: secondHunter.id }, g.deadline - 1);
  assert.equal(view(g, secondHunter).action.type, "hunter");
  act(g, secondHunter.id, { type: "hunter", targetId: null }, g.deadline - 1);
  assert.deepEqual(g.hunterUsed, [firstHunter.id, secondHunter.id]);
});
