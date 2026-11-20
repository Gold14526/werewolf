/** Authoritative, dependency-free rules shared by the server and the local demo. */
export const ROLE_INFO = Object.freeze({
  wolf: { name: '狼人', team: 'wolf', description: '每晚与同伴共同选择一名玩家袭击。' },
  villager: { name: '村民', team: 'good', description: '白天通过发言和投票找出狼人。' },
  seer: { name: '预言家', team: 'good', description: '每晚查验一名玩家的阵营。' },
  witch: { name: '女巫', team: 'good', description: '各有一瓶解药与毒药，每晚最多使用一种；仅首夜可以自救。' },
  hunter: { name: '猎人', team: 'good', description: '被袭击或放逐后可开枪带走一人；被毒杀不能开枪。' },
  guard: { name: '守卫', team: 'good', description: '每晚守护一人，不能连续守护同一人；同守同救仍会死亡。' },
});

export const STANDARD_CONFIG = Object.freeze({
  roles: Object.freeze({ wolf: 4, villager: 4, seer: 1, witch: 1, hunter: 1, guard: 1 }),
  victory: 'side', nightSeconds: 45, daySeconds: 90,
});

const NIGHT_PHASES = ['guard', 'wolf', 'seer', 'witch'];
const LABELS = { guard: '守卫行动', wolf: '狼人行动', seer: '预言家行动', witch: '女巫行动', discussion: '轮流发言', lastwords: '遗言阶段', vote: '放逐投票', hunter: '猎人开枪', finished: '对局结束' };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function assert(condition, message) { if (!condition) throw new Error(message); }

export function validateConfig(input = STANDARD_CONFIG) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '房间配置不正确');
  const rawRoles = input.roles ?? STANDARD_CONFIG.roles;
  assert(rawRoles && typeof rawRoles === 'object' && !Array.isArray(rawRoles), '身份配置不正确');
  assert(Object.keys(rawRoles).every(key => own(ROLE_INFO, key)), '包含不支持的身份');
  const roles = {};
  for (const role of Object.keys(ROLE_INFO)) {
    const count = rawRoles[role] ?? 0;
    assert(Number.isInteger(count) && count >= 0, '身份人数必须为非负整数');
    assert(count <= (role === 'wolf' ? 6 : role === 'villager' ? 12 : 1), '该身份人数超出范围');
    roles[role] = count;
  }
  const total = Object.values(roles).reduce((a, b) => a + b, 0);
  assert(total >= 6 && total <= 18, '总人数需要在 6 至 18 人之间');
  assert(roles.wolf >= 1 && roles.wolf < total / 2, '狼人至少 1 人，且必须少于总人数的一半');
  assert(roles.villager >= 1, '至少需要 1 位村民');
  const victory = input.victory ?? 'side';
  assert(victory === 'side' || victory === 'all', '胜利条件不正确');
  assert(victory !== 'side' || roles.seer + roles.witch + roles.hunter + roles.guard > 0, '屠边模式至少需要一个神职');
  const nightSeconds = input.nightSeconds ?? 45;
  const daySeconds = input.daySeconds ?? 90;
  assert([30, 45, 60].includes(nightSeconds), '夜间行动时间不正确');
  assert([60, 90, 120].includes(daySeconds), '白天讨论时间不正确');
  return { roles, victory, nightSeconds, daySeconds };
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
  const game = {
    config, phase: 'guard', round: 1, deadline: 0, winner: null,
    players: players.map((p, i) => ({ id: p.id, name: p.name, seat: p.seat ?? i + 1, role: roles[i], alive: true })),
    log: [], audit: [], actions: Object.create(null), night: {}, previousGuard: null, potions: { save: true, poison: true },
    investigations: Object.create(null), pendingHunters: [], hunterUsed: [], resume: null,
    currentSpeakerId: null, speechQueue: [], lastWordsQueue: [], runoff: false, voteTargets: null,
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
  game.audit.push({ round: game.round, text: `【复盘】${text}`, at: now, seq: game.eventSequence });
}
function targetLabel(game, id) { const target = player(game, id); return target ? `${target.seat} 号` : '无人'; }
function live(game) { return game.players.filter(p => p.alive); }
function player(game, id) { return game.players.find(p => p.id === id); }
function eligible(game) {
  if (game.phase === 'hunter') return game.pendingHunters.length ? [game.pendingHunters[0]] : [];
  if (game.phase === 'vote') return live(game).filter(p => !game.runoff || !game.voteTargets.includes(p.id)).map(p => p.id);
  if (NIGHT_PHASES.includes(game.phase)) return live(game).filter(p => p.role === game.phase).map(p => p.id);
  return [];
}
function setPhase(game, phase, now) {
  game.phase = phase;
  game.actions = Object.create(null);
  game.currentSpeakerId = null;
  game.deadline = now + (['discussion', 'lastwords'].includes(phase) ? game.config.daySeconds : game.config.nightSeconds) * 1000;
}
function beginNight(game, now) {
  game.runoff = false;
  game.voteTargets = null;
  game.speechQueue = [];
  game.night = { guard: null, victim: null, poison: null, saved: false };
  nextNightPhase(game, -1, now);
}
function nextNightPhase(game, index, now) {
  for (let i = index + 1; i < NIGHT_PHASES.length; i++) {
    const phase = NIGHT_PHASES[i];
    // Retain configured stages even when their role is dead: skipping one reveals
    // the dead player's hidden role. Fixed night timers preserve that privacy.
    if (game.config.roles[phase] > 0) {
      setPhase(game, phase, now);
      return;
    }
  }
  resolveNight(game, now);
}
function leadingTargets(actions) {
  const counts = new Map();
  for (const action of Object.values(actions)) {
    if (action.targetId != null) counts.set(action.targetId, (counts.get(action.targetId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked.filter(entry => entry[1] === ranked[0][1]).map(entry => entry[0]) : [];
}
function plurality(actions) {
  const targets = leadingTargets(actions);
  return targets.length === 1 ? targets[0] : null;
}
function beginDiscussion(game, now, ids = null) {
  game.speechQueue = (ids ? ids.map(id => player(game, id)).filter(p => p?.alive) : live(game)).sort((a, b) => a.seat - b.seat).map(p => p.id);
  setPhase(game, 'discussion', now);
  game.currentSpeakerId = game.speechQueue[0] ?? null;
  if (!game.currentSpeakerId) beginVote(game, now);
}
function beginVote(game, now) {
  addLog(game, game.runoff ? '平票发言结束，进行第二轮投票；平票玩家不参与投票。' : '发言结束，请选择要放逐的玩家。', now);
  setPhase(game, 'vote', now);
  if (!eligible(game).length) finishPhase(game, now);
}
function eliminate(game, id, cause) {
  const target = player(game, id);
  if (!target || !target.alive) return;
  target.alive = false;
  if (target.role === 'hunter' && cause !== 'poison' && !game.hunterUsed.includes(id)) game.pendingHunters.push(id);
}
function finishOrResume(game, resume, now) {
  if (game.pendingHunters.length) {
    game.resume = resume;
    setPhase(game, 'hunter', now);
    const hunter = player(game, game.pendingHunters[0]);
    addLog(game, `${hunter.seat} 号玩家发动猎人技能。`, now);
    return;
  }
  if (game.lastWordsQueue.length) {
    game.resume = resume;
    setPhase(game, 'lastwords', now);
    game.currentSpeakerId = game.lastWordsQueue[0];
    return;
  }
  if (checkWinner(game, now)) return;
  if (resume === 'discussion') beginDiscussion(game, now);
  else {
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
function resolveNight(game, now) {
  const { victim, guard, poison, saved } = game.night;
  const deaths = new Map();
  // Exactly one of guard protection and witch rescue prevents the wolf kill.
  if (victim && ((guard === victim) === saved)) deaths.set(victim, 'wolf');
  if (poison) deaths.set(poison, 'poison');
  for (const [id, cause] of deaths) eliminate(game, id, cause);
  if (game.round === 1) game.lastWordsQueue.push(...deaths.keys());
  const seats = [...deaths.keys()].map(id => player(game, id)?.seat).filter(Boolean).sort((a, b) => a - b);
  addLog(game, seats.length ? `天亮了，昨夜 ${seats.join('、')} 号玩家出局。` : '天亮了，昨夜是平安夜。', now);
  finishOrResume(game, 'discussion', now);
}
function checkWinner(game, now) {
  const living = live(game);
  let winner = null;
  if (!living.some(p => p.role === 'wolf')) winner = 'good';
  else if (game.config.victory === 'all') {
    if (!living.some(p => p.role !== 'wolf')) winner = 'wolf';
  } else if (!living.some(p => p.role === 'villager') || !living.some(p => p.role !== 'wolf' && p.role !== 'villager')) winner = 'wolf';
  if (!winner) return false;
  game.winner = winner;
  game.phase = 'finished';
  game.deadline = null;
  game.currentSpeakerId = null;
  game.actions = Object.create(null);
  addLog(game, winner === 'good' ? '所有狼人已出局，好人阵营获胜。' : '狼人达成胜利条件，狼人阵营获胜。', now);
  return true;
}

function finishPhase(game, now) {
  const phase = game.phase;
  if (phase === 'guard') {
    const id = eligible(game)[0];
    game.night.guard = game.actions[id]?.targetId ?? null;
    game.previousGuard = game.night.guard;
    addAudit(game, id ? `${player(game, id).seat} 号守卫守护：${targetLabel(game, game.night.guard)}。` : '守卫已出局，本夜无守护。', now);
  } else if (phase === 'wolf') {
    game.night.victim = plurality(game.actions);
    const ballots = eligible(game).map(id => `${player(game, id).seat} 号→${targetLabel(game, game.actions[id]?.targetId)}`).join('，');
    addAudit(game, `狼人投票：${ballots}；最终袭击：${targetLabel(game, game.night.victim)}。`, now);
  }
  else if (phase === 'seer') {
    const id = eligible(game)[0];
    const target = player(game, game.actions[id]?.targetId);
    if (target) {
      (game.investigations[id] ??= []).push({ round: game.round, id: target.id, seat: target.seat, name: target.name, team: ROLE_INFO[target.role].team });
    }
    addAudit(game, id ? `${player(game, id).seat} 号预言家${target ? `查验 ${target.seat} 号，结果为${target.role === 'wolf' ? '狼人' : '好人'}` : '未进行查验'}。` : '预言家已出局，本夜无查验。', now);
  } else if (phase === 'witch') {
    const id = eligible(game)[0];
    const action = game.actions[id];
    if (action?.choice === 'save') { game.night.saved = true; game.potions.save = false; }
    else if (action?.choice === 'poison') { game.night.poison = action.targetId; game.potions.poison = false; }
    addAudit(game, id ? `${player(game, id).seat} 号女巫${action?.choice === 'save' ? `使用解药救助 ${targetLabel(game, game.night.victim)}` : action?.choice === 'poison' ? `使用毒药毒杀 ${targetLabel(game, action.targetId)}` : '未使用药剂'}。` : '女巫已出局，本夜未用药。', now);
  } else if (phase === 'discussion') {
    game.speechQueue.shift();
    if (game.speechQueue.length) {
      setPhase(game, 'discussion', now);
      game.currentSpeakerId = game.speechQueue[0];
    } else beginVote(game, now);
    return;
  } else if (phase === 'lastwords') {
    game.lastWordsQueue.shift();
    const resume = game.resume;
    game.resume = null;
    finishOrResume(game, resume, now);
    return;
  } else if (phase === 'vote') {
    const leaders = leadingTargets(game.actions);
    const targetId = leaders.length === 1 ? leaders[0] : null;
    const voters = eligible(game);
    const votes = game.players.filter(p => voters.includes(p.id)).map(p => {
      const target = player(game, game.actions[p.id]?.targetId);
      return `${p.seat}→${target ? target.seat : '弃票'}`;
    }).join('，');
    addLog(game, `投票结果：${votes}。`, now);
    if (leaders.length > 1 && !game.runoff) {
      game.runoff = true;
      game.voteTargets = leaders;
      addLog(game, `${leaders.map(id => player(game, id).seat).join('、')} 号玩家平票，依次发言后重新投票。`, now);
      beginDiscussion(game, now, leaders);
      return;
    }
    if (targetId) {
      eliminate(game, targetId, 'vote');
      game.lastWordsQueue.push(targetId);
      addLog(game, `${player(game, targetId).seat} 号玩家被放逐。`, now);
    } else addLog(game, '票数相同或全员弃票，本轮无人被放逐。', now);
    finishOrResume(game, 'night', now);
    return;
  } else if (phase === 'hunter') {
    const id = game.pendingHunters.shift();
    const targetId = game.actions[id]?.targetId;
    game.hunterUsed.push(id);
    if (targetId) {
      eliminate(game, targetId, 'shot');
      if ((game.resume === 'discussion' && game.round === 1) || game.resume === 'night') game.lastWordsQueue.push(targetId);
      addLog(game, `猎人带走了 ${player(game, targetId).seat} 号玩家。`, now);
    } else addLog(game, '猎人选择不开枪。', now);
    const resume = game.resume;
    game.resume = null;
    finishOrResume(game, resume, now);
    return;
  } else return;
  nextNightPhase(game, NIGHT_PHASES.indexOf(phase), now);
}

/** Mutates game. Only moves a due phase once, giving every new phase its full timer. */
export function advance(game, now = Date.now()) {
  if (game.phase !== 'finished' && now >= game.deadline) finishPhase(game, now);
  return game;
}

export function act(game, playerId, action, now = Date.now()) {
  assert(game.phase !== 'finished', '对局已经结束');
  if (now >= game.deadline) {
    advance(game, now);
    throw new Error('该阶段已结束，请刷新对局状态');
  }
  assert(action && typeof action === 'object', '行动格式不正确');
  const actor = player(game, playerId);
  if (action.type === 'pass') {
    assert(['discussion', 'lastwords'].includes(game.phase) && game.currentSpeakerId === playerId, '还没有轮到你发言');
    finishPhase(game, now);
    return game;
  }
  if (action.type === 'explode') {
    assert(actor?.alive && actor.role === 'wolf' && ['discussion', 'vote'].includes(game.phase), '当前不能自爆');
    actor.revealed = true;
    eliminate(game, actor.id, 'explode');
    addLog(game, `${actor.seat} 号狼人自爆，白天立即结束。`, now);
    game.speechQueue = [];
    game.lastWordsQueue = [];
    finishOrResume(game, 'night', now);
    return game;
  }
  assert(action.type === game.phase, '当前不是该行动阶段');
  assert(eligible(game).includes(playerId), '你不能在此阶段行动');
  assert(!own(game.actions, playerId), '你已经提交了本轮行动');
  const targetId = action.targetId ?? null;
  assert(targetId === null || typeof targetId === 'string', '目标编号不正确');
  const target = targetId === null ? null : player(game, targetId);
  assert(targetId === null || (target && target.alive), '请选择仍在场的玩家');
  if (game.phase === 'guard') assert(targetId === null || targetId !== game.previousGuard, '不能连续两晚守护同一名玩家');
  if (game.phase === 'seer') assert(targetId !== playerId, '不能查验自己');
  if (game.phase === 'vote') {
    assert(targetId !== playerId, '不能投票给自己');
    assert(targetId === null || !game.runoff || game.voteTargets.includes(targetId), '第二轮只能投给平票玩家');
  }
  let choice;
  if (game.phase === 'witch') {
    choice = action.choice ?? 'skip';
    assert(['skip', 'save', 'poison'].includes(choice), '女巫行动不正确');
    if (choice === 'save') {
      assert(game.potions.save && game.night.victim, '当前不能使用解药');
      assert(game.night.victim !== actor.id || game.round === 1, '女巫仅首夜可以自救');
      assert(targetId === null || targetId === game.night.victim, '解药只能救助昨夜被袭击的玩家');
    } else if (choice === 'poison') assert(game.potions.poison && target, '请选择毒药目标，且必须保有毒药');
    else assert(targetId === null, '放弃用药时不能选择目标');
  }
  game.actions[playerId] = { targetId, ...(choice ? { choice } : {}) };
  if (!NIGHT_PHASES.includes(game.phase) && eligible(game).every(id => own(game.actions, id))) finishPhase(game, now);
  return game;
}

/** The server must apply this predicate before accepting game chat messages. */
export function canChat(game, playerId, channel = 'public') {
  const viewer = player(game, playerId);
  if (!viewer) return false;
  if (channel === 'wolf' || channel === 'wolves') return viewer.alive && viewer.role === 'wolf' && game.phase === 'wolf';
  if (channel !== 'public') return false;
  if (game.phase === 'finished') return true;
  return ['discussion', 'lastwords'].includes(game.phase) && game.currentSpeakerId === playerId;
}

export function viewGame(game, viewerId) {
  const viewer = player(game, viewerId);
  assert(viewer, '你不在这个房间中');
  const submitted = own(game.actions, viewerId);
  const canPass = ['discussion', 'lastwords'].includes(game.phase) && game.currentSpeakerId === viewerId;
  const actionable = canPass || (eligible(game).includes(viewerId) && !submitted);
  const publicPlayer = p => ({ id: p.id, name: p.name, seat: p.seat, alive: p.alive,
    ...(game.phase === 'finished' || p.revealed || p.id === viewerId || (viewer.role === 'wolf' && p.role === 'wolf') ? { role: p.role } : {}),
  });
  let action = null;
  const privateInfo = {};
  if (viewer.role === 'seer') privateInfo.results = (game.investigations[viewerId] ?? []).map(r => ({ ...r }));
  if (viewer.role === 'wolf') {
    privateInfo.wolfTeammates = game.players.filter(p => p.role === 'wolf' && p.id !== viewerId).map(p => ({ id: p.id, name: p.name, seat: p.seat }));
    if (game.phase === 'wolf') privateInfo.wolfVotes = Object.entries(game.actions).map(([playerId, action]) => ({ playerId, targetId: action.targetId }));
  }
  if (viewer.role === 'witch') {
    privateInfo.potions = { ...game.potions };
    // Once the antidote is gone, the witch no longer learns the wolves' target.
    if (game.phase === 'witch' && game.potions.save && viewer.alive) {
      const victim = player(game, game.night.victim);
      privateInfo.nightVictim = victim ? { id: victim.id, name: victim.name, seat: victim.seat } : null;
    }
  }
  if (actionable) {
    let targets = live(game);
    if (game.phase === 'guard') targets = targets.filter(p => p.id !== game.previousGuard);
    if (game.phase === 'seer') targets = targets.filter(p => p.id !== viewerId);
    if (game.phase === 'vote') targets = targets.filter(p => p.id !== viewerId && (!game.runoff || game.voteTargets.includes(p.id)));
    action = { type: game.phase, targets: targets.map(p => ({ id: p.id, name: p.name, seat: p.seat })) };
    if (canPass) action = { type: 'pass', targets: [] };
    if (game.phase === 'witch') {
      action.choices = ['skip'];
      if (game.potions.save && game.night.victim && (game.night.victim !== viewerId || game.round === 1)) action.choices.push('save');
      if (game.potions.poison) action.choices.push('poison');
    }
  }
  return {
    config: { ...game.config, roles: { ...game.config.roles } }, phase: game.phase, phaseLabel: LABELS[game.phase], round: game.round,
    deadline: game.deadline, winner: game.winner, players: game.players.map(publicPlayer), myRole: viewer.role,
    log: (game.phase === 'finished' ? [...game.log, ...game.audit].sort((a, b) => a.at - b.at || a.seq - b.seq) : game.log).map(({ round, text, at }) => ({ round, text, at })), actionable, submitted, action, privateInfo,
    currentSpeakerId: game.currentSpeakerId, canSpeak: canChat(game, viewerId), canWolfChat: canChat(game, viewerId, 'wolf'),
    canExplode: viewer.alive && viewer.role === 'wolf' && ['discussion', 'vote'].includes(game.phase),
    runoff: game.runoff, voteTargets: game.voteTargets ? [...game.voteTargets] : null,
  };
}
