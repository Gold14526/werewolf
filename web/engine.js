/** Authoritative, dependency-free rules shared by the server and the local demo. */
export const ROLE_INFO = Object.freeze({
  wolf: { name: '狼人', team: 'wolf', description: '每晚与同伴共同选择一名玩家袭击。' },
  wolfKing: { name: '狼王', team: 'wolf', description: '参与夜间袭击。若本人出局后对局仍继续，可在正式出局前开枪。被毒杀、自爆、在骑士决斗中落败或被白狼王带走时不能开枪。' },
  whiteWolfKing: { name: '白狼王', team: 'wolf', description: '参与夜间袭击；白天发言时可自爆并带走一人，被带走者不能发动死亡技能。' },
  villager: { name: '村民', team: 'good', description: '白天通过发言和投票找出狼人。' },
  seer: { name: '预言家', team: 'good', description: '每晚查验一名玩家的阵营。' },
  witch: { name: '女巫', team: 'good', description: '各有一瓶解药与毒药，每晚最多使用一种。自救依房间规则。' },
  hunter: { name: '猎人', team: 'good', description: '被袭击或放逐后，若对局仍继续，可在正式出局前开枪带走一人；被毒杀或白狼王带走时不能开枪。' },
  fool: { name: '愚者', team: 'good', description: '首次被放逐时翻牌免死，之后仍可发言，但失去投票权且不能再被放逐。' },
  knight: { name: '骑士', team: 'good', description: '白天发言阶段可决斗一次：对方是狼人则对方出局并入夜，否则自己出局、发言继续。' },
  guard: { name: '守卫', team: 'good', description: '每晚守护一人，不能连续守护同一人；同守同救仍会死亡。' },
});

export const STANDARD_CONFIG = Object.freeze({
  roles: Object.freeze({ wolf: 4, wolfKing: 0, whiteWolfKing: 0, villager: 4, seer: 1, witch: 1, hunter: 1, guard: 1, fool: 0, knight: 0 }),
  victory: 'side', nightSeconds: 75, otherNightSeconds: 30, witchSelfSave: 'first', shuffleSeats: false, daySeconds: 90, sheriff: false,
});

const NIGHT_PHASES = ['guard', 'wolf', 'seer', 'witch'];
const VOTE_PHASES = ['vote', 'sheriff_vote'];
const INACTIVITY_MS = 60_000;
const AFK_SPEECH_MS = 2_000;
const SPEECH_PHASES = ['discussion', 'lastwords', 'sheriff_speech'];
export const isWolfRole = role => ROLE_INFO[role]?.team === 'wolf';
const LABELS = { night: '夜间', guard: '守卫行动', wolf: '狼人行动', seer: '预言家行动', witch: '女巫行动', discussion: '轮流发言', lastwords: '遗言阶段', vote: '放逐投票', hunter: '开枪', sheriff_signup: '上警报名', sheriff_speech: '竞选发言', sheriff_vote: '警长投票', sheriff_transfer: '警徽移交', sheriff_direction: '选择发言方向', finished: '对局结束' };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function assert(condition, message) { if (!condition) throw new Error(message); }

export function roleLimit(role) {
  if (role === 'wolf') return 6;
  if (role === 'villager') return 12;
  return isWolfRole(role) ? 8 : 18;
}

export function validateConfig(input = STANDARD_CONFIG) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '房间配置不正确');
  const rawRoles = input.roles ?? STANDARD_CONFIG.roles;
  assert(rawRoles && typeof rawRoles === 'object' && !Array.isArray(rawRoles), '身份配置不正确');
  assert(Object.keys(rawRoles).every(key => own(ROLE_INFO, key)), '包含不支持的身份');
  const roles = {};
  for (const role of Object.keys(ROLE_INFO)) {
    const count = rawRoles[role] ?? 0;
    assert(Number.isInteger(count) && count >= 0, '身份人数必须为非负整数');
    assert(count <= roleLimit(role), '该身份人数超出范围');
    roles[role] = count;
  }
  const total = Object.values(roles).reduce((a, b) => a + b, 0);
  assert(total >= 6 && total <= 18, '总人数需要在 6 至 18 人之间');
  const wolves = Object.entries(roles).reduce((n, [role, count]) => n + (isWolfRole(role) ? count : 0), 0);
  assert(wolves >= 1 && wolves < total / 2, '狼人至少 1 人，且必须少于总人数的一半');
  const victory = input.victory ?? 'side';
  assert(victory === 'side' || victory === 'all', '胜利条件不正确');
  assert(victory !== 'side' || roles.villager >= 1, '屠边模式至少需要 1 位村民');
  assert(victory !== 'side' || roles.seer + roles.witch + roles.hunter + roles.guard + roles.fool + roles.knight > 0, '屠边模式至少需要一个神职');
  const nightSeconds = input.nightSeconds ?? 75;
  const otherNightSeconds = input.otherNightSeconds ?? 30;
  const witchSelfSave = input.witchSelfSave ?? 'first';
  assert([30, 40, 50].includes(otherNightSeconds), '其它行动时间不正确');
  assert(['none', 'first', 'always'].includes(witchSelfSave), '女巫自救规则不正确');
  const daySeconds = input.daySeconds ?? 90;
  assert([30, 45, 60, 75, 90].includes(nightSeconds), '夜间行动时间不正确');
  assert([60, 90, 120].includes(daySeconds), '白天讨论时间不正确');
  const shuffleSeats = input.shuffleSeats ?? false;
  assert(typeof shuffleSeats === 'boolean', '随机排座选项必须为布尔值');
  const sheriff = input.sheriff ?? false;
  assert(typeof sheriff === 'boolean', '上警选项必须为布尔值');
  return { roles, victory, nightSeconds, otherNightSeconds, witchSelfSave, shuffleSeats, daySeconds, sheriff };
}

function shuffled(values, random) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const r = random();
    assert(Number.isFinite(r) && r >= 0 && r < 1, '随机数生成器不正确');
    const j = Math.floor(r * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function createGame(players, input = STANDARD_CONFIG, { now = Date.now(), random = Math.random } = {}) {
  const config = validateConfig(input);
  const deck = Object.entries(config.roles).flatMap(([role, count]) => Array(count).fill(role));
  assert(Array.isArray(players) && players.length === deck.length, '玩家人数与配置不一致');
  assert(players.every(p => p && typeof p.id === 'string' && p.id && typeof p.name === 'string'), '玩家信息不正确');
  assert(new Set(players.map(p => p.id)).size === players.length, '玩家编号重复');
  const roles = shuffled(deck, random);
  const seated = config.shuffleSeats ? shuffled(players, random) : players;
  const game = {
    config, phase: 'night', round: 1, deadline: 0, winner: null,
    players: seated.map((p, i) => ({ id: p.id, name: p.name, seat: config.shuffleSeats ? i + 1 : (p.seat ?? i + 1), role: roles[i], alive: true,
      ...(roles[i] === 'witch' ? { potions: { save: true, poison: true } } : {}),
      ...(roles[i] === 'guard' ? { previousGuard: null } : {}),
    })),
    log: [], audit: [], actions: Object.create(null), night: {},
    investigations: Object.create(null), pendingHunters: [], hunterUsed: [], resume: null,
    currentSpeakerId: null, speechQueue: [], lastWordsQueue: [], runoff: false, voteTargets: null,
    sheriffId: null, sheriffElectionDone: false, sheriffCandidates: [], sheriffVoters: [], sheriffRunoff: false, pendingBadgeId: null, knightUsed: [],
  };
  addLog(game, '天黑了，请闭眼。', now);
  beginNight(game, now);
  return game;
}

function addLog(game, text, now) {
  game.eventSequence = (game.eventSequence ?? 0) + 1;
  game.log.push({ round: game.round, text, at: now, seq: game.eventSequence });
  if (game.log.length > 200) game.log.splice(0, game.log.length - 200);
}
function addAudit(game, text, now) {
  game.eventSequence = (game.eventSequence ?? 0) + 1;
  const entry = { round: game.round, text: `【复盘】${text}`, at: now, seq: game.eventSequence };
  (game.audit ??= []).push(entry);
  return entry;
}
function targetLabel(game, id) { const target = player(game, id); return target ? `${target.seat} 号` : '无人'; }
export function isPendingDeath(game, id) {
  return id != null && Boolean(game && (game.pendingHunters?.includes(id) || game.pendingBadgeId === id));
}
function isStanding(game, p) { return p?.alive && !isPendingDeath(game, p.id); }
function live(game) { return game.players.filter(p => isStanding(game, p)); }
function player(game, id) { return game.players.find(p => p.id === id); }
function eligible(game) {
  if (game.phase === 'hunter') return game.pendingHunters.length ? [game.pendingHunters[0]] : [];
  if (game.phase === 'sheriff_signup') return live(game).map(p => p.id);
  if (game.phase === 'sheriff_vote') return live(game).filter(p => (game.sheriffVoters ?? []).includes(p.id)).map(p => p.id);
  if (game.phase === 'sheriff_transfer') return game.pendingBadgeId ? [game.pendingBadgeId] : [];
  if (game.phase === 'sheriff_direction') return player(game, game.sheriffId)?.alive ? [game.sheriffId] : [];
  if (game.phase === 'vote') return live(game).filter(p => !p.foolRevealed && (!game.runoff || !game.voteTargets.includes(p.id))).map(p => p.id);
  if (game.phase === 'night') return live(game).filter(p => nightTurn(game, p)).map(p => p.id);
  return [];
}
function setPhase(game, phase, now) {
  game.phase = phase;
  game.actions = Object.create(null);
  game.currentSpeakerId = null;
  game.inactivityDeadline = null;
  game.deadline = now + (SPEECH_PHASES.includes(phase) ? game.config.daySeconds : game.config.otherNightSeconds) * 1000;
}
function beginNight(game, now) {
  game.runoff = false;
  game.voteTargets = null;
  game.speechQueue = [];
  game.pausedSpeeches = [];
  game.inactivityDeadline = null;
  game.night = { guards: [], victim: null, poisons: [], saved: false };
  game.actions = Object.create(null);
  game.currentSpeakerId = null;
  scheduleNight(game, now);
}

// Windows store offsets from the next checkpoint. Restart recovery can move the
// single game.deadline and every public and private countdown moves with it.
function scheduleNight(game, now, firstRole = 'guard', elapsed = 0) {
  const windows = [];
  let end = 0;
  for (const role of NIGHT_PHASES.slice(NIGHT_PHASES.indexOf(firstRole))) {
    // Every valid deck has wolves. Keep configured dead roles on the clock as well.
    if (role !== 'wolf' && !game.config.roles[role]) continue;
    const seconds = role === 'wolf' ? game.config.nightSeconds : game.config.otherNightSeconds;
    end += Math.max(0, seconds * 1000 - (role === firstRole ? elapsed : 0));
    windows.push({ role, end });
  }
  game.phase = 'night';
  game.night.sequential = true;
  game.deadline = now + windows[0].end;
  game.night.windows = windows.map(w => ({ role: w.role, offset: w.end - windows[0].end }));
}

export function migrateNightConfig(game, now = Date.now()) {
  const oldTimer = game.config.otherNightSeconds == null;
  // Snapshots written before duplicate good roles used a single potion inventory
  // and last guard target. Attach those to the original actors, alive or dead.
  const oldResources = own(game, 'potions') || own(game, 'previousGuard');
  if (oldResources) {
    for (const actor of game.players) {
      if (actor.role === 'witch' && !actor.potions) actor.potions = { ...potionsFor(game, actor) };
      if (actor.role === 'guard' && !own(actor, 'previousGuard')) actor.previousGuard = game.previousGuard ?? null;
    }
    delete game.potions;
    delete game.previousGuard;
  }
  const changed = oldTimer || oldResources || game.config.witchSelfSave == null || game.config.shuffleSeats == null;
  game.config.otherNightSeconds ??= 30;
  game.config.witchSelfSave ??= 'first';
  game.config.shuffleSeats ??= false;
  if (!NIGHT_PHASES.includes(game.phase)) {
    if (oldTimer && game.phase !== 'night' && game.phase !== 'finished' && !SPEECH_PHASES.includes(game.phase)) {
      const started = game.deadline - game.config.nightSeconds * 1000;
      game.deadline = started + game.config.otherNightSeconds * 1000;
    }
    return changed;
  }
  const phase = game.phase;
  const elapsed = Math.max(0, now - (game.deadline - game.config.nightSeconds * 1000));
  // Old clients submitted an antidote with no explicit target.
  if (phase === 'witch') {
    for (const action of Object.values(game.actions)) {
      if (action.choice === 'save' && !action.targetId) action.targetId = game.night.victim;
    }
  }
  scheduleNight(game, now, phase, elapsed);
  return true;
}

function nightWindowForRole(game, role) {
  const windows = game.night.windows;
  if (game.night.sequential) return windows[0].role === role ? windows[0] : null;
  // A saved parallel night retains the windows, ballots and private deadlines it opened with.
  if (role === 'witch' && windows.some(w => w.role === 'wolf')) return null;
  return windows.find(w => w.role === role) ?? null;
}
function nightTurn(game, actor) {
  if (game.phase !== 'night' || !actor?.alive) return null;
  return nightWindowForRole(game, isWolfRole(actor.role) ? 'wolf' : actor.role);
}

function publicNightStages(game) {
  if (game.phase !== 'night') return [];
  // Read only the configured schedule. Dead roles retain their windows, and
  // legacy parallel nights can have several active roles with distinct deadlines.
  return NIGHT_PHASES.flatMap(role => {
    const window = nightWindowForRole(game, role);
    return window ? [{ type: role, label: LABELS[role], deadline: game.deadline + window.offset }] : [];
  });
}

function potionsFor(game, witch) {
  return witch.potions ?? game.potions ?? { save: true, poison: true };
}

function canSave(game, witch) {
  if (!potionsFor(game, witch).save || !game.night.victim) return false;
  return game.night.victim !== witch.id || game.config.witchSelfSave === 'always' ||
    (game.config.witchSelfSave === 'first' && game.round === 1);
}
function wolfBallots(game) {
  return Object.fromEntries(Object.entries(game.actions).filter(([id]) => isWolfRole(player(game, id)?.role)));
}
// Before structured wolf ballots, this exact server-generated audit line was the
// only persistent record of the pack's votes. Never expose free-form audit text.
function readLegacyWolfAttack(game, text) {
  const match = /^【复盘】狼人投票：(.*)；最终袭击：(无人|\d+ 号)。$/u.exec(text);
  if (!match) return null;
  const playerAt = label => game.players.find(p => p.seat === Number.parseInt(label, 10));
  const targetFrom = label => label === '无人' ? null : playerAt(label)?.id;
  const targetId = targetFrom(match[2]);
  if (targetId === undefined) return null;
  const ballots = [];
  for (const vote of match[1] ? match[1].split('，') : []) {
    const pair = /^(\d+) 号→(无人|\d+ 号)$/u.exec(vote);
    if (!pair) return { targetId, ballots: null };
    const voter = playerAt(pair[1]);
    const choice = targetFrom(pair[2]);
    if (!isWolfRole(voter?.role) || choice === undefined) return { targetId, ballots: null };
    ballots.push({ playerId: voter.id, targetId: choice });
  }
  return { targetId, ballots };
}

function recordedWolfAttack(game, entry) {
  return entry.wolfAttack ?? (entry.text?.startsWith('【复盘】狼人投票：') ? readLegacyWolfAttack(game, entry.text) : null);
}

function snapshotWolfAttack(game) {
  // Initializing a night writes victim:null before anyone has voted.
  if (!game.night || !own(game.night, 'victim') || ['guard', 'wolf'].includes(game.phase)) return null;
  if (game.phase === 'night' && game.night.windows.some(w => w.role === 'wolf')) return null;
  const targetId = game.night.victim;
  return targetId === null || player(game, targetId) ? { targetId, ballots: null } : null;
}

function preserveLegacyWolfAttack(game, now) {
  const attack = snapshotWolfAttack(game);
  if (attack && !(game.audit ?? []).some(entry => entry.round === game.round && recordedWolfAttack(game, entry))) {
    const entry = addAudit(game, `狼人最终袭击：${targetLabel(game, attack.targetId)}（旧记录无逐票信息）。`, now);
    entry.wolfAttack = attack;
  }
}

function wolfHistory(game) {
  const nights = new Map();
  for (const entry of game.audit ?? []) {
    if (!Number.isInteger(entry.round)) continue;
    const attack = recordedWolfAttack(game, entry);
    if (attack && (entry.wolfAttack || !nights.has(entry.round))) {
      const ballots = attack.ballots?.map(({ playerId, targetId }) => ({ playerId, targetId })) ?? null;
      nights.set(entry.round, { round: entry.round, targetId: attack.targetId, ballots });
    }
  }
  if (!nights.has(game.round)) {
    const attack = snapshotWolfAttack(game);
    if (attack) nights.set(game.round, { round: game.round, ...attack });
  }
  return [...nights.values()].sort((a, b) => a.round - b.round);
}

function advanceNight(game, now) {
  while (game.phase === 'night' && now >= game.deadline) {
    const windows = game.night.windows;
    while (windows.length && windows[0].offset === 0) {
      resolveNightRole(game, windows.shift().role, game.deadline);
    }
    if (!windows.length) {
      resolveNight(game, now);
      return;
    }
    const delta = windows[0].offset;
    game.deadline += delta;
    for (const w of windows) w.offset -= delta;
  }
}
function leadingTargets(actions, sheriffId = null) {
  const counts = new Map();
  for (const [id, action] of Object.entries(actions)) {
    if (action.targetId != null) counts.set(action.targetId, (counts.get(action.targetId) ?? 0) + (id === sheriffId ? 1.5 : 1));
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked.filter(entry => entry[1] === ranked[0][1]).map(entry => entry[0]) : [];
}
function plurality(actions) {
  const targets = leadingTargets(actions);
  return targets.length === 1 ? targets[0] : null;
}

function dawnDeathSeats(game) {
  if (Array.isArray(game.night?.publicDeathSeats)) return game.night.publicDeathSeats;
  // A pre-upgrade room may be in last words or badge transfer. Only recover
  // seats from public announcements. A saved or guarded target is not a death.
  const entries = game.log.filter(entry => entry.round === game.round);
  const dawn = entries.findIndex(entry => entry.text.startsWith('天亮了，昨夜'));
  if (dawn < 0) return null;
  const text = entries[dawn].text;
  if (text !== '天亮了，昨夜是平安夜。') {
    const report = /^天亮了，昨夜 (.+)。$/.exec(text);
    if (!report || !report[1].split('，').every(part => /^\d+(?:、\d+)* 号玩家(?:出局|遇袭|等待出局结算)$/.test(part))) return null;
  }
  const seats = new Set((text.match(/\d+/g) ?? []).map(Number));
  for (const entry of entries.slice(dawn + 1)) {
    const hit = /^(?:\d+ 号(?:猎人|狼王)开枪击中 (\d+) 号 玩家|(?:猎人|狼王)带走了 (\d+) 号玩家)。$/.exec(entry.text);
    if (hit) seats.add(Number(hit[1] ?? hit[2]));
  }
  return [...seats];
}

function speakersAfter(speakers, seat, direction = 'right') {
  const ordered = speakers.sort((a, b) => a.seat - b.seat);
  if (direction === 'left') ordered.reverse();
  const next = seat == null ? 0 : ordered.findIndex(p => direction === 'left' ? p.seat < seat : p.seat > seat);
  return (next > 0 ? [...ordered.slice(next), ...ordered.slice(0, next)] : ordered).map(p => p.id);
}

function beginDiscussion(game, now, ids = null) {
  game.pausedSpeeches = [];
  if (!ids && isStanding(game, player(game, game.sheriffId))) {
    setPhase(game, 'sheriff_direction', now);
    return;
  }
  const deaths = ids ? null : dawnDeathSeats(game);
  const speakers = ids ? live(game).filter(p => ids.includes(p.id)) : live(game);
  startDiscussion(game, now, speakersAfter(speakers, deaths?.length ? Math.min(...deaths) : null));
}
function startSpeech(game, phase, id, now) {
  setPhase(game, phase, now);
  game.currentSpeakerId = id;
  if (player(game, id)?.afk) {
    game.deadline = now + AFK_SPEECH_MS;
  } else {
    game.inactivityDeadline = now + INACTIVITY_MS;
  }
  const paused = phase === 'discussion' && game.pausedSpeeches?.find(turn => turn.id === id);
  if (paused) {
    game.pausedSpeeches = game.pausedSpeeches.filter(turn => turn.id !== id);
    if (paused.afk === Boolean(player(game, id)?.afk)) {
      game.deadline = now + paused.remaining;
      game.inactivityDeadline = paused.idleRemaining == null ? null : now + paused.idleRemaining;
    }
  }
}

function checkSpeechTimer(game, now) {
  if (!SPEECH_PHASES.includes(game.phase)) return false;
  const speaker = player(game, game.currentSpeakerId);
  if (!speaker || speaker.afk) return false;
  // Old saved games have no input clock. Start it when the room resumes.
  game.inactivityDeadline ??= now + INACTIVITY_MS;
  if (now < game.inactivityDeadline || game.deadline < game.inactivityDeadline) return false;
  speaker.afk = true;
  addLog(game, `${speaker.seat} 号玩家连续 60 秒未键入，已判定为挂机。`, now);
  if (live(game).every(p => p.afk)) {
    // The first election takes place before night deaths are announced. Apply
    // that night's results before deciding whether the remaining players draw.
    if (game.phase === 'sheriff_speech' && !game.sheriffElectionDone) {
      finishElection(game, null, now);
      return true;
    }
    if (checkWinner(game, now)) return true;
  }
  finishPhase(game, now);
  return true;
}

function startDiscussion(game, now, ids) {
  game.speechQueue = ids.filter(id => player(game, id)?.alive);
  if (game.speechQueue.length) startSpeech(game, 'discussion', game.speechQueue[0], now);
  else beginVote(game, now);
}
function beginSheriffSpeech(game, now) {
  const candidates = game.sheriffCandidates;
  if (candidates.length < 2) { finishElection(game, candidates[0] ?? null, now); return; }
  game.speechQueue = game.players.filter(p => candidates.includes(p.id) && p.alive).sort((a, b) => a.seat - b.seat).map(p => p.id);
  startSpeech(game, 'sheriff_speech', game.speechQueue[0], now);
}
function beginSheriffVote(game, now) {
  if (game.sheriffCandidates.length < 2) { finishElection(game, game.sheriffCandidates[0] ?? null, now); return; }
  setPhase(game, 'sheriff_vote', now);
  addLog(game, game.sheriffRunoff ? '警长平票复投；仅最初未上警的玩家可以投票。' : '竞选发言结束；仅最初未上警的玩家可以投票，退水玩家不能投票。', now);
  if (!eligible(game).length) finishElection(game, null, now);
}
function finishElection(game, sheriffId, now) {
  game.sheriffId = sheriffId;
  game.sheriffElectionDone = true;
  game.sheriffCandidates = [];
  game.speechQueue = [];
  addLog(game, sheriffId ? `${targetLabel(game, sheriffId)} 当选警长，放逐票计 1.5 票。` : '本局无人当选警长，警徽流失。', now);
  resolveNight(game, now);
}
function beginVote(game, now) {
  addLog(game, game.runoff ? '平票发言结束，进行第二轮投票；平票玩家不参与投票。' : '发言结束，请选择要放逐的玩家。', now);
  setPhase(game, 'vote', now);
  if (!eligible(game).length) finishPhase(game, now);
}
function eliminate(game, id, cause) {
  const target = player(game, id);
  if (!isStanding(game, target)) return false;
  const canShoot = target.role === 'hunter' ? !['poison', 'whiteWolf'].includes(cause) : target.role === 'wolfKing' && !['poison', 'explode', 'duel', 'whiteWolf'].includes(cause);
  if (canShoot && !game.hunterUsed.includes(id)) game.pendingHunters.push(id);
  if (game.sheriffId === id) game.pendingBadgeId = id;
  if (!isPendingDeath(game, id)) target.alive = false;
  return true;
}

// A single player may have both a shot and a badge. Older snapshots already
// marked the actor dead when queuing either ability; never revive that seat.
function finishElimination(game, id, now) {
  const actor = player(game, id);
  if (actor?.alive && !isPendingDeath(game, id)) {
    actor.alive = false;
    addLog(game, `${actor.seat} 号玩家出局。`, now);
  }
}
function finishOrResume(game, resume, now) {
  // Count a whole night or ability's eliminations together before offering any death actions.
  const hasDeathTurn = game.pendingHunters.length || game.pendingBadgeId || game.lastWordsQueue.length;
  if (checkWinner(game, now, !hasDeathTurn)) return;
  if (game.pendingHunters.length) {
    game.resume = resume;
    setPhase(game, 'hunter', now);
    addLog(game, '正在结算出局前的行动。', now);
    return;
  }
  if (game.pendingBadgeId) {
    game.resume = resume;
    setPhase(game, 'sheriff_transfer', now);
    addLog(game, `${targetLabel(game, game.pendingBadgeId)} 请移交警徽或撕毁警徽。`, now);
    return;
  }
  if (game.lastWordsQueue.length) {
    game.resume = resume;
    startSpeech(game, 'lastwords', game.lastWordsQueue[0], now);
    return;
  }
  if (resume?.type === 'discussion') {
    let queue = resume.queue;
    if (resume.transferBadge && queue.includes(game.sheriffId)) queue = [...queue.filter(id => id !== game.sheriffId), game.sheriffId];
    startDiscussion(game, now, queue);
  } else if (resume === 'discussion') beginDiscussion(game, now);
  else {
    // Preserve any pointer left in a pre-audit snapshot before replacing game.night.
    preserveLegacyWolfAttack(game, now);
    if (game.round >= 20) {
      game.winner = 'draw'; game.phase = 'finished'; game.deadline = null; game.currentSpeakerId = null;
      addLog(game, '已完成 20 个夜晚，双方仍未达成胜利条件，本局平局。', now);
      return;
    }
    game.round++;
    addLog(game, '天黑了，请闭眼。', now);
    beginNight(game, now);
  }
}
function resolveNight(game, now, resume = 'discussion') {
  if (game.round === 1 && game.config.sheriff && !game.sheriffElectionDone) {
    setPhase(game, 'sheriff_signup', now);
    addLog(game, '天亮前进行警长竞选；死讯将在竞选结束后公布。请选择是否上警。', now);
    return;
  }
  const { victim, saved } = game.night;
  // A restored night can already have settled the guard or witch under the old format.
  const guards = game.night.guards ?? (game.night.guard ? [game.night.guard] : []);
  const poisons = game.night.poisons ?? (game.night.poison ? [game.night.poison] : []);
  const deaths = new Map();
  // Exactly one of guard protection and witch rescue prevents the wolf kill.
  if (victim && (guards.includes(victim) === saved)) deaths.set(victim, 'wolf');
  for (const id of poisons) deaths.set(id, 'poison');
  const casualties = [...deaths].filter(([id, cause]) => eliminate(game, id, cause)).map(([id]) => player(game, id));
  if (game.round === 1) game.lastWordsQueue.push(...casualties.map(p => p.id));
  const out = casualties.filter(p => !p.alive).map(p => p.seat).sort((a, b) => a - b);
  const waiting = casualties.filter(p => p.alive).map(p => p.seat).sort((a, b) => a - b);
  const reports = [];
  if (out.length) reports.push(`${out.join('、')} 号玩家出局`);
  if (waiting.length) reports.push(`${waiting.join('、')} 号玩家遇袭`);
  addLog(game, reports.length ? `天亮了，昨夜 ${reports.join('，')}。` : '天亮了，昨夜是平安夜。', now);
  game.night.publicDeathSeats = casualties.map(p => p.seat);
  finishOrResume(game, resume, now);
}
function checkWinner(game, now, includeAfkDraw = true) {
  const living = live(game);
  let winner = null;
  if (!living.some(p => isWolfRole(p.role))) winner = 'good';
  else if (game.config.victory === 'all') {
    if (!living.some(p => !isWolfRole(p.role))) winner = 'wolf';
  } else if (!living.some(p => p.role === 'villager') || !living.some(p => !isWolfRole(p.role) && p.role !== 'villager')) winner = 'wolf';
  if (!winner && includeAfkDraw && living.length && living.every(p => p.afk)) winner = 'draw';
  if (!winner) return false;
  preserveLegacyWolfAttack(game, now);
  const pending = game.players.filter(p => isPendingDeath(game, p.id));
  game.pendingHunters = [];
  game.pendingBadgeId = null;
  for (const p of pending) finishElimination(game, p.id, now);
  if (!player(game, game.sheriffId)?.alive) game.sheriffId = null;
  game.lastWordsQueue = [];
  game.speechQueue = [];
  game.inactivityDeadline = null;
  game.resume = null;
  game.winner = winner;
  game.phase = 'finished';
  game.deadline = null;
  game.currentSpeakerId = null;
  game.actions = Object.create(null);
  const outcomes = { good: '所有狼人已出局，好人阵营获胜。', wolf: '狼人达成胜利条件，狼人阵营获胜。', draw: '所有存活玩家均已挂机，本局平局。' };
  addLog(game, outcomes[winner], now);
  return true;
}

function resolveNightRole(game, phase, now) {
  if (phase === 'wolf') {
    game.night.victim = plurality(wolfBallots(game));
    const ballots = live(game).filter(p => isWolfRole(p.role)).map(p => ({ playerId: p.id, targetId: game.actions[p.id]?.targetId ?? null }));
    const voteText = ballots.map(v => `${targetLabel(game, v.playerId)}→${targetLabel(game, v.targetId)}`).join('，');
    const entry = addAudit(game, `狼人投票：${voteText}；最终袭击：${targetLabel(game, game.night.victim)}。`, now);
    entry.wolfAttack = { targetId: game.night.victim, ballots };
    return;
  }
  const actors = live(game).filter(p => p.role === phase);
  if (!actors.length) addAudit(game, `${ROLE_INFO[phase].name}已全部出局，本夜无行动。`, now);
  if (phase === 'guard') game.night.guards = [];
  if (phase === 'witch') game.night.poisons = [];
  for (const actor of actors) {
    const action = own(game.actions, actor.id) ? game.actions[actor.id] : null;
    const target = player(game, action?.targetId);
    if (phase === 'guard') {
      actor.previousGuard = target?.id ?? null;
      if (target && !game.night.guards.includes(target.id)) game.night.guards.push(target.id);
      addAudit(game, `${actor.seat} 号守卫守护：${targetLabel(game, actor.previousGuard)}。`, now);
    } else if (phase === 'seer') {
      if (target) {
        const result = { round: game.round, id: target.id, seat: target.seat, name: target.name, team: ROLE_INFO[target.role].team };
        const prior = own(game.investigations, actor.id) ? game.investigations[actor.id] : [];
        game.investigations = { ...game.investigations, [actor.id]: [...prior, result] };
      }
      addAudit(game, `${actor.seat} 号预言家${target ? `查验 ${target.seat} 号，结果为${isWolfRole(target.role) ? '狼人' : '好人'}` : '未进行查验'}。`, now);
    } else if (phase === 'witch') {
      actor.potions ??= { ...potionsFor(game, actor) };
      if (action?.choice === 'save') {
        game.night.saved = true;
        actor.potions.save = false;
      } else if (action?.choice === 'poison') {
        if (!game.night.poisons.includes(target.id)) game.night.poisons.push(target.id);
        actor.potions.poison = false;
      }
      addAudit(game, `${actor.seat} 号女巫${action?.choice === 'save' ? `使用解药救助 ${targetLabel(game, game.night.victim)}` : action?.choice === 'poison' ? `使用毒药毒杀 ${targetLabel(game, action.targetId)}` : '未使用药剂'}。`, now);
    }
  }
}

function finishPhase(game, now) {
  const phase = game.phase;
  if (phase === 'sheriff_signup') {
    game.sheriffCandidates = live(game).filter(p => game.actions[p.id]?.choice === 'join').map(p => p.id);
    game.sheriffVoters = live(game).filter(p => !game.sheriffCandidates.includes(p.id)).map(p => p.id);
    game.sheriffRunoff = false;
    addLog(game, game.sheriffCandidates.length ? `上警玩家：${game.sheriffCandidates.map(id => targetLabel(game, id)).join('、')}。` : '无人上警。', now);
    beginSheriffSpeech(game, now);
    return;
  } else if (phase === 'sheriff_speech') {
    game.speechQueue.shift();
    if (game.speechQueue.length) startSpeech(game, 'sheriff_speech', game.speechQueue[0], now);
    else beginSheriffVote(game, now);
    return;
  } else if (phase === 'sheriff_vote') {
    const leaders = leadingTargets(game.actions);
    addLog(game, `警长票型：${eligible(game).map(id => `${targetLabel(game, id)}→${targetLabel(game, game.actions[id]?.targetId)}`).join('，')}。`, now);
    if (leaders.length > 1 && !game.sheriffRunoff) {
      game.sheriffRunoff = true; game.sheriffCandidates = leaders;
      addLog(game, '警长竞选平票，平票者再次发言并复投；再次平票则警徽流失。', now);
      beginSheriffSpeech(game, now);
    } else finishElection(game, leaders.length === 1 ? leaders[0] : null, now);
    return;
  } else if (phase === 'sheriff_transfer') {
    const from = game.pendingBadgeId, to = game.actions[from]?.targetId ?? null;
    game.sheriffId = to; game.pendingBadgeId = null;
    addLog(game, to ? `${targetLabel(game, from)} 将警徽移交给 ${targetLabel(game, to)}。` : `${targetLabel(game, from)} 撕毁警徽，本局不再设警长。`, now);
    finishElimination(game, from, now);
    const resume = game.resume; game.resume = null; finishOrResume(game, resume, now); return;
  } else if (phase === 'sheriff_direction') {
    const choice = game.actions[game.sheriffId]?.choice ?? 'right';
    const queue = speakersAfter(live(game), player(game, game.sheriffId)?.seat, choice);
    addLog(game, `警长选择${choice === 'left' ? '逆座位号' : '顺座位号'}方向发言，警长最后发言。`, now);
    startDiscussion(game, now, queue); return;
  } else if (phase === 'discussion') {
    game.speechQueue.shift();
    if (game.speechQueue.length) {
      startSpeech(game, 'discussion', game.speechQueue[0], now);
    } else beginVote(game, now);
    return;
  } else if (phase === 'lastwords') {
    game.lastWordsQueue.shift();
    const resume = game.resume;
    game.resume = null;
    finishOrResume(game, resume, now);
    return;
  } else if (phase === 'vote') {
    const leaders = leadingTargets(game.actions, game.sheriffId);
    const targetId = leaders.length === 1 ? leaders[0] : null;
    const voters = eligible(game);
    const votes = game.players.filter(p => voters.includes(p.id)).map(p => {
      const target = player(game, game.actions[p.id]?.targetId);
      return `${p.seat}${p.id === game.sheriffId ? '（1.5票）' : ''}→${target ? target.seat : '弃票'}`;
    }).join('，');
    addLog(game, `投票结果：${votes}。`, now);
    if (leaders.length > 1 && !game.runoff) {
      game.runoff = true;
      game.voteTargets = leaders;
      addLog(game, `${leaders.map(id => player(game, id).seat).join('、')} 号玩家平票，依次发言后重新投票。`, now);
      beginDiscussion(game, now, leaders);
      return;
    }
    if (targetId && player(game, targetId).role === 'fool' && !player(game, targetId).foolRevealed) {
      const fool = player(game, targetId); fool.foolRevealed = true; fool.revealed = true;
      if (game.sheriffId === targetId) { game.sheriffId = null; addLog(game, '愚者翻牌，警徽随之流失。', now); }
      addLog(game, `${fool.seat} 号愚者翻牌免死，此后不能投票或被放逐。`, now);
    } else if (targetId) {
      eliminate(game, targetId, 'vote');
      game.lastWordsQueue.push(targetId);
      addLog(game, `${player(game, targetId).seat} 号玩家被放逐。`, now);
    } else addLog(game, '票数相同或全员弃票，本轮无人被放逐。', now);
    finishOrResume(game, 'night', now);
    return;
  } else if (phase === 'hunter') {
    const id = game.pendingHunters.shift();
    const targetId = game.actions[id]?.targetId;
    const shooter = player(game, id);
    const roleName = ROLE_INFO[shooter.role].name;
    game.hunterUsed.push(id);
    if (targetId && targetId !== id && eliminate(game, targetId, 'shot')) {
      shooter.revealed = true;
      if (game.resume === 'discussion') {
        const seats = dawnDeathSeats(game);
        if (seats) game.night.publicDeathSeats = [...seats, player(game, targetId).seat];
      }
      if ((game.resume === 'discussion' && game.round === 1) || game.resume === 'night') game.lastWordsQueue.push(targetId);
      addLog(game, `${shooter.seat} 号${roleName}开枪击中 ${targetLabel(game, targetId)} 玩家。`, now);
    } else {
      addAudit(game, `${shooter.seat} 号${roleName}未开枪。`, now);
    }
    finishElimination(game, id, now);
    const resume = game.resume;
    game.resume = null;
    finishOrResume(game, resume, now);
    return;
  } else return;
}

// Older saved games may already be awaiting a gun, badge, or last words after
// a winning elimination. End them before accepting or timing out that action.
function finishWinningDeathTurn(game, now) {
  return ['hunter', 'sheriff_transfer', 'lastwords'].includes(game.phase) && checkWinner(game, now, false);
}

/** Advance due night windows together. Newly opened daytime phases receive their full timer. */
export function advance(game, now = Date.now()) {
  migrateNightConfig(game, now);
  if (finishWinningDeathTurn(game, now)) return game;
  if (game.phase === 'night') { advanceNight(game, now); return game; }
  if (checkSpeechTimer(game, now)) return game;
  if (game.phase !== 'finished' && now >= game.deadline) finishPhase(game, now);
  return game;
}

function canExplode(game, actor) {
  return Boolean(actor?.alive && isWolfRole(actor.role) && (actor.role === 'whiteWolfKing' ? ['discussion', 'sheriff_speech'] : ['discussion', 'vote', 'sheriff_speech']).includes(game.phase));
}
function canDuel(game, actor) { return Boolean(actor?.alive && actor.role === 'knight' && !(game.knightUsed ?? []).includes(actor.id) && game.phase === 'discussion'); }

export function act(game, playerId, action, now = Date.now()) {
  migrateNightConfig(game, now);
  assert(!finishWinningDeathTurn(game, now), '对局已经结束');
  if (game.phase === 'night') {
    advanceNight(game, now);
    assert(game.phase === 'night', '该阶段已结束，请刷新对局状态');
  }
  assert(game.phase !== 'finished', '对局已经结束');
  if (checkSpeechTimer(game, now)) throw new Error('该发言阶段已结束，请刷新对局状态');
  if (now >= game.deadline) {
    advance(game, now);
    throw new Error('该阶段已结束，请刷新对局状态');
  }
  assert(action && typeof action === 'object', '行动格式不正确');
  const actor = player(game, playerId);
  assert(actor, '你不是本局玩家');
  if (action.turnDeadline != null && (VOTE_PHASES.includes(action.type) || ['pass', 'typing'].includes(action.type))) {
    assert(action.turnDeadline === game.deadline, '该阶段已结束，请刷新对局状态');
  }
  if (action.type === 'typing') {
    assert(SPEECH_PHASES.includes(game.phase) && game.currentSpeakerId === playerId, '还没有轮到你发言');
    if (!actor.afk) game.inactivityDeadline = now + INACTIVITY_MS;
    return game;
  }
  if (action.type === 'return') {
    if (actor.afk) {
      actor.afk = false;
      if (SPEECH_PHASES.includes(game.phase) && game.currentSpeakerId === playerId) startSpeech(game, game.phase, playerId, now);
    }
    return game;
  }
  if (action.type === 'pass') {
    assert(SPEECH_PHASES.includes(game.phase) && game.currentSpeakerId === playerId, '还没有轮到你发言');
    finishPhase(game, now);
    return game;
  }
  if (action.type === 'withdraw') {
    assert(actor?.alive && game.phase === 'sheriff_speech' && game.sheriffCandidates.includes(playerId), '当前不能退水');
    game.sheriffCandidates = game.sheriffCandidates.filter(id => id !== playerId);
    game.speechQueue = game.speechQueue.filter(id => id !== playerId);
    addLog(game, `${actor.seat} 号退出警长竞选。`, now);
    if (game.sheriffCandidates.length < 2) finishElection(game, game.sheriffCandidates[0] ?? null, now);
    else if (!game.speechQueue.length) beginSheriffVote(game, now);
    else if (game.currentSpeakerId === playerId) startSpeech(game, 'sheriff_speech', game.speechQueue[0], now);
    return game;
  }
  if (action.type === 'explode') {
    assert(canExplode(game, actor), '当前不能自爆');
    const targetId = action.targetId ?? null;
    assert(targetId === null || (typeof targetId === 'string' && actor.role === 'whiteWolfKing' && targetId !== actor.id && player(game, targetId)?.alive), '白狼王只能带走其他仍在场的玩家');
    const duringElection = game.phase === 'sheriff_speech';
    actor.revealed = true;
    eliminate(game, actor.id, 'explode');
    if (targetId) eliminate(game, targetId, 'whiteWolf');
    addLog(game, `${actor.seat} 号${ROLE_INFO[actor.role].name}自爆${targetId ? `，带走 ${targetLabel(game, targetId)}` : ''}，白天立即结束。`, now);
    game.speechQueue = []; game.lastWordsQueue = [];
    if (duringElection) {
      game.sheriffElectionDone = true; game.sheriffId = null; game.sheriffCandidates = [];
      addLog(game, '警上自爆，警徽流失；公布昨夜死讯后进入下一夜。', now);
      resolveNight(game, now, 'night');
    } else finishOrResume(game, 'night', now);
    return game;
  }
  if (action.type === 'duel') {
    assert(canDuel(game, actor), '当前不能决斗');
    const target = player(game, action.targetId);
    assert(target?.alive && target.id !== actor.id, '请选择其他仍在场的玩家');
    (game.knightUsed ??= []).push(actor.id); actor.revealed = true;
    if (isWolfRole(target.role)) {
      target.revealed = true; eliminate(game, target.id, 'duel');
      addLog(game, `${actor.seat} 号骑士决斗 ${target.seat} 号，目标是狼人，结算后入夜。`, now);
      game.speechQueue = []; game.lastWordsQueue = [];
      finishOrResume(game, 'night', now);
    } else {
      let queue = game.speechQueue.filter(id => id !== actor.id);
      if (!game.sheriffId) {
        queue = speakersAfter(live(game).filter(p => queue.includes(p.id)), actor.seat);
      }
      if (queue.includes(game.currentSpeakerId)) {
        const speaker = player(game, game.currentSpeakerId);
        (game.pausedSpeeches ??= []).push({ id: speaker.id, afk: Boolean(speaker.afk), remaining: game.deadline - now,
          idleRemaining: game.inactivityDeadline == null ? null : game.inactivityDeadline - now });
      }
      const resume = { type: 'discussion', queue, transferBadge: game.sheriffId === actor.id };
      eliminate(game, actor.id, 'duel');
      addLog(game, `${actor.seat} 号骑士决斗 ${target.seat} 号，目标是好人，骑士按决斗规则退场，结算后继续发言。`, now);
      finishOrResume(game, resume, now);
    }
    return game;
  }
  const turn = nightTurn(game, actor);
  const actionPhase = game.phase === 'night' ? turn?.role : game.phase;
  assert(action.type === actionPhase, '当前不是该行动阶段');
  assert(eligible(game).includes(playerId), '你不能在此阶段行动');
  if (turn) {
    if (action.round != null) assert(action.round === game.round, '本夜已结束，请刷新对局状态');
    if (action.turnDeadline != null) assert(action.turnDeadline === game.deadline + turn.offset, '行动时间已变更，请刷新对局状态');
  }
  assert(turn || VOTE_PHASES.includes(game.phase) || !own(game.actions, playerId), '你已经提交了本轮行动');
  const targetId = action.targetId ?? null;
  assert(targetId === null || typeof targetId === 'string', '目标编号不正确');
  const target = targetId === null ? null : player(game, targetId);
  assert(targetId === null || isStanding(game, target), '请选择仍在场的玩家');
  if (actionPhase === 'guard') assert(targetId === null || targetId !== actor.previousGuard, '不能连续两晚守护同一名玩家');
  if (actionPhase === 'seer') assert(targetId !== playerId, '不能查验自己');
  if (game.phase === 'vote') {
    assert(targetId !== playerId, '不能投票给自己');
    assert(!target?.foolRevealed, '不能投票给已翻牌的愚者');
    assert(targetId === null || !game.runoff || game.voteTargets.includes(targetId), '第二轮只能投给平票玩家');
  }
  if (game.phase === 'sheriff_vote') assert(targetId === null || game.sheriffCandidates.includes(targetId), '只能投给正在竞选的玩家');
  if (game.phase === 'sheriff_transfer') assert(!target?.foolRevealed, '不能将警徽交给已翻牌的愚者');
  let choice;
  if (game.phase === 'sheriff_signup' || game.phase === 'sheriff_direction') {
    choice = action.choice ?? (game.phase === 'sheriff_signup' ? 'skip' : 'right');
    assert((game.phase === 'sheriff_signup' ? ['join', 'skip'] : ['left', 'right']).includes(choice) && targetId === null, '阶段选项不正确');
  }
  if (actionPhase === 'witch') {
    choice = action.choice ?? 'skip';
    assert(['skip', 'save', 'poison'].includes(choice), '女巫行动不正确');
    if (choice === 'save') {
      assert(potionsFor(game, actor).save && game.night.victim, '当前不能使用解药');
      assert(canSave(game, actor), '本晚不能自救');
      assert(targetId === game.night.victim, '请选择本夜被刀的玩家使用解药');
    } else if (choice === 'poison') assert(potionsFor(game, actor).poison && target, '请选择毒药目标，且必须保有毒药');
    else assert(targetId === null, '放弃用药时不能选择目标');
  }
  game.actions = { ...game.actions, [playerId]: { targetId, ...(choice ? { choice } : {}) } };
  if (game.phase !== 'night' && !VOTE_PHASES.includes(game.phase) && eligible(game).every(id => own(game.actions, id))) finishPhase(game, now);
  return game;
}

/** The server must apply this predicate before accepting game chat messages. */
export function canChat(game, playerId, channel = 'public') {
  const viewer = player(game, playerId);
  if (!viewer) return false;
  if (channel === 'wolf' || channel === 'wolves') return nightTurn(game, viewer)?.role === 'wolf';
  if (channel !== 'public') return false;
  if (game.phase === 'finished') return true;
  return SPEECH_PHASES.includes(game.phase) && game.currentSpeakerId === playerId;
}

export function viewGame(game, viewerId) {
  // Only a room-authorized spectator is passed as null by the server.
  const viewer = viewerId === null ? { id: null, role: null, alive: false } : player(game, viewerId);
  assert(viewer, '你不在这个房间中');
  const submitted = viewerId !== null && own(game.actions, viewerId);
  const canPass = viewerId !== null && SPEECH_PHASES.includes(game.phase) && game.currentSpeakerId === viewerId;
  const turn = nightTurn(game, viewer);
  const actionable = canPass || (eligible(game).includes(viewerId) && (!submitted || Boolean(turn) || VOTE_PHASES.includes(game.phase)));
  const hasWolfView = game.phase !== 'finished' && isStanding(game, viewer) && isWolfRole(viewer.role);
  const publicPlayer = p => {
    const publicRole = game.phase === 'finished' || p.revealed || p.foolRevealed;
    const knowsRole = publicRole || p.id === viewerId || (hasWolfView && isWolfRole(p.role));
    return {
      id: p.id, name: p.name, seat: p.seat, alive: p.alive, afk: Boolean(p.afk),
      ...(p.foolRevealed ? { foolRevealed: true } : {}),
      ...(knowsRole ? { role: p.role } : {}),
      ...(publicRole ? { publicRole: p.role } : {}),
    };
  };
  let visiblePhase = game.phase;
  const nightStages = publicNightStages(game);
  let phaseLabel = nightStages.length ? nightStages.map(stage => stage.label).join('、') : LABELS[game.phase];
  if (game.phase === 'hunter') {
    const shooter = player(game, game.pendingHunters[0]);
    if (shooter && (shooter.id === viewerId || shooter.revealed)) {
      phaseLabel = ROLE_INFO[shooter.role].name + '开枪';
    } else {
      visiblePhase = 'resolution';
      phaseLabel = '技能结算';
    }
  }
  let action = null;
  const actionPhase = turn?.role ?? game.phase;
  const privateInfo = {};
  if (viewer.role === 'seer') privateInfo.results = (own(game.investigations, viewerId) ? game.investigations[viewerId] : []).map(r => ({ ...r }));
  if (hasWolfView) {
    privateInfo.wolfHistory = wolfHistory(game);
    privateInfo.wolfTeammates = game.players.filter(p => isWolfRole(p.role) && p.id !== viewerId).map(p => ({ id: p.id, name: p.name, seat: p.seat }));
    if (turn?.role === 'wolf') privateInfo.wolfVotes = Object.entries(wolfBallots(game)).map(([playerId, action]) => ({ playerId, targetId: action.targetId }));
  }
  if (viewer.role === 'witch') {
    privateInfo.potions = { ...potionsFor(game, viewer) };
    // An empty attack is explicit. After using the antidote, a victim's identity stays hidden.
    if (turn?.role === 'witch' && (privateInfo.potions.save || !game.night.victim)) {
      const victim = player(game, game.night.victim);
      privateInfo.nightVictim = victim ? { id: victim.id, name: victim.name, seat: victim.seat } : null;
    }
  }
  if (actionable) {
    let targets = live(game);
    if (actionPhase === 'guard') targets = targets.filter(p => p.id !== (own(viewer, 'previousGuard') ? viewer.previousGuard : game.previousGuard));
    if (actionPhase === 'seer') targets = targets.filter(p => p.id !== viewerId);
    if (game.phase === 'vote') targets = targets.filter(p => !p.foolRevealed && p.id !== viewerId && (!game.runoff || game.voteTargets.includes(p.id)));
    if (game.phase === 'sheriff_vote') targets = targets.filter(p => game.sheriffCandidates.includes(p.id));
    if (game.phase === 'sheriff_transfer') targets = targets.filter(p => !p.foolRevealed);
    if (game.phase === 'sheriff_signup' || game.phase === 'sheriff_direction') targets = [];
    action = { type: actionPhase, ...(turn ? { deadline: game.deadline + turn.offset } : {}), targets: targets.map(p => ({ id: p.id, name: p.name, seat: p.seat })) };
    if (turn && submitted) action.selected = { ...game.actions[viewerId] };
    if (canPass) action = { type: 'pass', targets: [] };
    if (game.phase === 'sheriff_signup') action.choices = ['join', 'skip'];
    if (game.phase === 'sheriff_direction') action.choices = ['left', 'right'];
    if (actionPhase === 'witch') {
      action.choices = ['skip'];
      if (canSave(game, viewer)) action.choices.push('save');
      if (privateInfo.potions.poison) action.choices.push('poison');
    }
  }
  return {
    config: { ...game.config, roles: { ...game.config.roles } }, phase: visiblePhase, phaseLabel, round: game.round,
    nightStages, deadline: game.deadline, winner: game.winner, players: game.players.map(publicPlayer), myRole: viewer.role,
    log: (game.phase === 'finished' ? [...game.log, ...(game.audit ?? [])].sort((a, b) => a.at - b.at || a.seq - b.seq) : game.log).map(({ round, text, at }) => ({ round, text, at })), actionable, submitted, action, privateInfo,
    currentSpeakerId: game.currentSpeakerId, canSpeak: canChat(game, viewerId), canWolfChat: canChat(game, viewerId, 'wolf'),
    myAfk: Boolean(viewer.afk),
    inactivityDeadline: canPass && !viewer.afk && game.inactivityDeadline <= game.deadline ? game.inactivityDeadline ?? null : null,
    myVoteTargetId: submitted && VOTE_PHASES.includes(game.phase) ? game.actions[viewerId].targetId : null,
    canExplode: canExplode(game, viewer),
    explodeTargets: canExplode(game, viewer) && viewer.role === 'whiteWolfKing' ? live(game).filter(p => p.id !== viewerId).map(p => ({ id: p.id, name: p.name, seat: p.seat })) : [],
    canDuel: canDuel(game, viewer),
    duelTargets: canDuel(game, viewer) ? live(game).filter(p => p.id !== viewerId).map(p => ({ id: p.id, name: p.name, seat: p.seat })) : [],
    sheriffId: game.sheriffId ?? null, sheriffElectionDone: Boolean(game.sheriffElectionDone), sheriffRunoff: Boolean(game.sheriffRunoff),
    sheriffCandidates: (game.sheriffCandidates ?? []).map(id => player(game, id)).filter(Boolean).map(p => ({ id: p.id, name: p.name, seat: p.seat })),
    canWithdraw: Boolean(viewer.alive && game.phase === 'sheriff_speech' && (game.sheriffCandidates ?? []).includes(viewerId)),
    runoff: game.runoff, voteTargets: game.voteTargets ? [...game.voteTargets] : null,
  };
}
