import { STANDARD_CONFIG, advance, isPendingDeath, isWolfRole, migrateNightConfig, viewGame } from '../web/engine.js';

const denied = () => Object.assign(new Error('观战时不能进行此操作'), { status: 403 });
export const capacity = room => Object.values(room.config.roles).reduce((sum, count) => sum + count, 0);
export const isWatcher = (room, id) => room?.spectators?.includes(id) ?? false;
export const hasSeat = (room, id) => room?.players.some(p => p.id === id && !p.retired) ?? false;
export const isMember = (room, id) => isWatcher(room, id) || hasSeat(room, id);

export function activeRoom(rooms, id) {
  for (const room of rooms.values()) {
    if (hasSeat(room, id) && (!room.game || (room.game.phase !== 'finished' && room.game.players.some(p => p.id === id && p.alive)))) return room;
  }
  return null;
}

export function memberships(rooms, id) {
  return [...rooms.values()].filter(room => isMember(room, id)).map(room => ({ code: room.code, name: room.name, isSpectator: isWatcher(room, id) }));
}

export function selectRoom(rooms, session, code, required = true) {
  const room = rooms.get(code ?? session.roomCode);
  if (room && isMember(room, session.id)) return room;
  if (code != null) throw Object.assign(new Error('你尚未加入这个房间'), { status: 403 });
  session.roomCode = null;
  if (required) throw Object.assign(new Error('请先进入房间'), { status: 404 });
  return null;
}

function watch(room, person, announce) {
  room.spectators ??= [];
  if (!isWatcher(room, person.id)) {
    room.spectators.push(person.id);
    announce?.(person.name + ' 加入了观战席');
  }
}

function unwatch(room, person, announce) {
  if (isWatcher(room, person.id)) {
    room.spectators = room.spectators.filter(id => id !== person.id);
    announce(person.name + ' 离开了观战席');
  }
}

function preserveMessageSeats(room) {
  if (room.messageSeatsVersion === 1) return;
  for (const message of room.messages) {
    if (message.playerId && message.seat === undefined) {
      message.seat = room.players.find(p => p.id === message.playerId)?.seat ?? null;
    }
  }
  room.messageSeatsVersion = 1;
}

export function updateRoom(room, now) {
  preserveMessageSeats(room);
  room.config.otherNightSeconds ??= 30;
  room.config.witchSelfSave ??= 'first';
  room.config.shuffleSeats ??= false;
  if (!room.game) {
    if (room.matchmaking) room.config.sheriff = STANDARD_CONFIG.sheriff;
    return;
  }
  migrateNightConfig(room.game, now);
  if (room.game.phase !== 'finished') advance(room.game, now);
  for (const person of room.players) {
    if (!person.retired && room.game.players.some(p => p.id === person.id && !p.alive)) {
      person.retired = true;
      watch(room, person);
    }
  }
}

export function recoverClock(game, savedAt, now) {
  if (!game || game.phase === 'finished') return;
  const speaker = game.players.find(p => p.id === game.currentSpeakerId);
  const minimum = speaker?.afk ? 0 : 30000;
  game.deadline = now + Math.max(minimum, game.deadline - savedAt);
  if (game.inactivityDeadline != null) game.inactivityDeadline = now + Math.max(0, game.inactivityDeadline - savedAt);
  migrateNightConfig(game, now);
}

export function synchronizeSeats(room) {
  for (const person of room.players) person.seat = room.game.players.find(p => p.id === person.id).seat;
  room.players.sort((a, b) => a.seat - b.seat);
}

function selectHost(room, announce) {
  if (room.game || room.players.some(p => p.id === room.hostId)) return;
  const next = room.players[0];
  room.hostId = next?.id ?? null;
  if (next) {
    next.ready = true;
    announce(next.name + ' 成为新房主');
  }
}

export function placeSeat(rooms, room, session, seat, ready, extra, announce) {
  if (room.game) throw new Error('对局开始后不能更换座位');
  if (seat === null) {
    if (isWatcher(room, session.id)) return;
    room.players = room.players.filter(p => p.id !== session.id);
    watch(room, session, announce);
    selectHost(room, announce);
    return;
  }
  if (!Number.isInteger(seat) || seat < 1 || seat > capacity(room)) throw new Error('请选择有效的空座位');
  const other = activeRoom(rooms, session.id);
  if (other && other !== room) throw new Error('你已在另一房间的玩家席上，请先离开该座位');
  if (room.players.some(p => p.seat === seat && p.id !== session.id)) throw new Error('该座位已有人');
  const current = room.players.find(p => p.id === session.id);
  if (current) current.seat = seat;
  else {
    unwatch(room, session, announce);
    room.players.push({ id: session.id, name: session.name, seat, ready, ...extra });
    announce(session.name + ' 加入了房间');
  }
  room.players.sort((a, b) => a.seat - b.seat);
  selectHost(room, announce);
}

export function enterRoom(rooms, room, session, ready, extra, announce) {
  if (!isMember(room, session.id)) {
    if (room.game || room.players.length >= capacity(room)) watch(room, session, announce);
    else {
      let seat = 1;
      while (room.players.some(p => p.seat === seat)) seat++;
      placeSeat(rooms, room, session, seat, ready, extra, announce);
    }
  }
  session.roomCode = room.code;
}

export function dropMember(rooms, room, person, announce) {
  if (isWatcher(room, person.id)) unwatch(room, person, announce);
  else {
    if (room.game && room.game.phase !== 'finished') throw new Error('对局进行中，暂时不能退出；刷新页面可重新连接');
    if (room.game) {
      const player = room.players.find(p => p.id === person.id);
      if (player) player.retired = true;
    } else room.players = room.players.filter(p => p.id !== person.id);
    announce(person.name + ' 离开了房间');
    selectHost(room, announce);
  }
  if (person.roomCode === room.code) person.roomCode = null;
  if (!room.players.some(p => !p.retired) && !room.spectators?.length) rooms.delete(room.code);
}

export function requireSeat(room, id) {
  if (!hasSeat(room, id)) throw denied();
}

// Legacy gallery members can finish a queued shot or badge. Their seat stays
// released even if an old snapshot is restored while that action is pending.
export function deathTurn(game, id) {
  if (!game) return false;
  return (game.phase === 'hunter' && game.pendingHunters[0] === id)
    || (game.phase === 'sheriff_transfer' && game.pendingBadgeId === id)
    || (game.phase === 'lastwords' && game.currentSpeakerId === id && game.players.some(p => p.id === id && !p.alive));
}

export function allowAction(room, id, type) {
  const pending = isPendingDeath(room.game, id);
  if (!pending && !isWatcher(room, id)) return;
  if (deathTurn(room.game, id)) {
    const phase = room.game.phase;
    if (phase === 'lastwords' ? ['pass', 'typing', 'return'].includes(type) : type === phase) return;
  }
  if (pending) throw Object.assign(new Error('请等待或完成当前出局技能'), { status: 403 });
  throw denied();
}

export function gameView(game, id, spectator = false) {
  const member = game.players.find(p => p.id === id);
  if (member && !spectator && !isPendingDeath(game, id)) return viewGame(game, id);
  const publicView = viewGame(game, null);
  if (member && !spectator) {
    publicView.myRole = member.role;
    publicView.players.find(p => p.id === id).role = member.role;
  }
  if (deathTurn(game, id)) {
    const own = viewGame(game, id);
    for (const key of ['phase', 'phaseLabel', 'actionable', 'submitted', 'action', 'canSpeak', 'myAfk', 'inactivityDeadline']) publicView[key] = own[key];
  }
  return publicView;
}

export function messagesFor(room, id, spectator) {
  const showWolfChat = !spectator && !isPendingDeath(room.game, id)
    && (room.game?.phase === 'finished' || isWolfRole(room.game?.players.find(p => p.id === id)?.role));
  // Archived rooms also pass through this projection on their first replay.
  preserveMessageSeats(room);
  return room.messages.filter(m => m.channel !== 'wolf' || showWolfChat);
}
