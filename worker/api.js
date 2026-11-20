import { STANDARD_CONFIG, validateConfig, createGame, act, advance, viewGame, canChat } from '../web/engine.js';
import { withState } from './store.js';

const MINUTE = 60000, HOUR = 60 * MINUTE;
const MAX_ROOMS = 20, MAX_SESSIONS = 500, MAX_HISTORY = 20, MAX_MESSAGES = 400;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const encoder = new TextEncoder();
const bytes = value => encoder.encode(JSON.stringify(value)).length;
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
const id = () => crypto.randomUUID();
const capacity = room => Object.values(room.config.roles).reduce((a, b) => a + b, 0);
function token() {
  const data = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...data)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function digest(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))].map(x => x.toString(16).padStart(2, '0')).join(''); }
function cleanName(value, fallback, maxLength = 16) {
  const text = typeof value === 'string' ? value.trim() : fallback;
  if (!text || [...text].length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) throw fail(`名称需为 1–${maxLength} 个字符`);
  return text;
}
function rate(state, key, count, duration, now) {
  let bucket = state.limits.get(key);
  if (!bucket || now >= bucket.until) {
    if (!bucket && state.limits.size >= 3000) throw fail('当前请求较多，请稍后重试', 503);
    state.limits.set(key, bucket = { count: 0, until: now + duration });
  }
  if (++bucket.count > count) throw fail('操作太频繁，请稍后再试', 429);
}
function sessionFor(state, hash, now) {
  const session = hash && state.sessions.get(hash);
  if (!session || now - session.lastSeen > 24 * HOUR) throw fail('登录状态已过期，请重新连接', 401);
  // Keep normal polling read-only between heartbeats to reduce contention.
  if (now - session.lastSeen >= 10000) session.lastSeen = now;
  return session;
}
function sessionById(state, playerId) { return [...state.sessions.values()].find(s => s.id === playerId); }
function currentRoom(state, session, required = true) {
  const room = session.roomCode && state.rooms.get(session.roomCode);
  if (!room || !room.players.some(p => p.id === session.id)) {
    session.roomCode = null;
    if (required) throw fail('请先进入房间', 404);
    return null;
  }
  return room;
}
function pushMessage(room, name, text, now, playerId = null, channel = 'public') {
  const seat = room.players.find(p => p.id === playerId)?.seat;
  room.messages.push({ id: id(), playerId, seat, name, text, channel, at: now, system: playerId === null });
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  trimRoom(room);
}
function trimRoom(room) {
  while (room.messages.length > 1 && bytes(room) > 220 * 1024) room.messages.shift();
}
function dropMember(state, room, session, now) {
  room.players = room.players.filter(p => p.id !== session.id);
  if (session.roomCode === room.code) session.roomCode = null;
  if (!room.players.length) state.rooms.delete(room.code);
  else {
    pushMessage(room, '系统', `${session.name} 离开了房间`, now);
    if (room.hostId === session.id) {
      room.hostId = room.players[0].id;
      room.players[0].ready = true;
      pushMessage(room, '系统', `${room.players[0].name} 成为新房主`, now);
    }
  }
}
function gameView(game, viewerId) {
  const member = game.players.some(p => p.id === viewerId);
  if (!member && game.phase !== 'finished') throw fail('你不在这个房间中', 403);
  const view = viewGame(game, member ? viewerId : game.players[0].id);
  if (!member) { view.myRole = null; view.privateInfo = {}; }
  return view;
}
function serialize(state, room, session, now) {
  if (!room) return null;
  return {
    code: room.code, name: room.name, hostId: room.hostId, visibility: room.visibility,
    matchmaking: room.matchmaking, config: room.config, createdAt: room.createdAt,
    players: room.players.map(p => ({ ...p, connected: now - (sessionById(state, p.id)?.lastSeen ?? 0) < 45000 })),
    messages: room.messages.filter(m => m.channel !== 'wolf' || room.game?.phase === 'finished' || room.game?.players.find(p => p.id === session.id)?.role === 'wolf'),
    game: room.game ? gameView(room.game, session.id) : null,
  };
}
function recordFinished(state, room, now) {
  if (!room.game || room.game.phase !== 'finished' || room.recorded) return;
  room.recorded = true;
  state.histories.set(room.code, structuredClone({ ...room, endedAt: now }));
  const ordered = [...state.histories.values()].sort((a, b) => a.endedAt - b.endedAt);
  while (ordered.length > MAX_HISTORY) state.histories.delete(ordered.shift().code);
  for (const p of room.game.players) {
    let stat = state.standings.get(p.id);
    if (!stat) state.standings.set(p.id, stat = { id: p.id, name: p.name, wins: 0, games: 0, winRate: 0, updatedAt: now });
    stat.games++;
    if ((p.role === 'wolf' ? 'wolf' : 'good') === room.game.winner) stat.wins++;
    stat.winRate = Math.round(stat.wins / stat.games * 100);
    stat.updatedAt = now;
  }
  while (state.standings.size > 2000) {
    const oldest = [...state.standings.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    state.standings.delete(oldest.id);
  }
  // Keep bounded snapshot memory even when many completed games have long transcripts.
  let retainedBytes = [...state.rooms.values(), ...state.histories.values()].reduce((sum, r) => sum + bytes(r), 0);
  for (const old of ordered) {
    if (retainedBytes <= 8 * 1024 * 1024) break;
    if (!state.histories.has(old.code)) continue;
    retainedBytes -= bytes(old);
    state.histories.delete(old.code);
  }
}
function start(room, now) {
  if (room.players.length !== capacity(room)) throw fail('人数未满，暂时不能开始');
  if (!room.players.every(p => p.ready)) throw fail('还有玩家未准备');
  room.game = createGame(room.players.map(({ id, name, seat }) => ({ id, name, seat })), room.config, { now, random });
  pushMessage(room, '系统', '对局开始，天黑请闭眼。', now);
}
function enter(state, room, session, now, autoReady = false) {
  const existing = currentRoom(state, session, false);
  if (existing) {
    if (existing.code === room.code) return;
    throw fail('你已在其他房间中，请先退出当前房间');
  }
  if (room.game) throw fail('该房间已经开始游戏');
  if (room.players.length >= capacity(room)) throw fail('房间已满');
  const used = new Set(room.players.map(p => p.seat));
  let seat = 1; while (used.has(seat)) seat++;
  room.players.push({ id: session.id, name: session.name, seat, ready: autoReady });
  session.roomCode = room.code;
  session.lastSeen = now;
  room.lastActive = now;
  pushMessage(room, '系统', `${session.name} 加入了房间`, now);
  if (room.matchmaking && room.players.length === capacity(room)) start(room, now);
}
function newRoom(state, session, data, now, matchmaking = false) {
  if (currentRoom(state, session, false)) throw fail('请先退出当前房间');
  if (state.rooms.size >= MAX_ROOMS) throw fail('当前在线房间较多，请稍后再试', 503);
  const config = validateConfig(matchmaking ? STANDARD_CONFIG : data.config ?? STANDARD_CONFIG);
  let code;
  for (let n = 0; n < 100; n++) {
    const candidate = String(100000 + Math.floor(random() * 900000));
    if (!state.rooms.has(candidate) && !state.histories.has(candidate)) { code = candidate; break; }
  }
  if (!code) throw fail('暂时无法分配房号，请重试', 503);
  const visibility = matchmaking ? 'public' : data.visibility ?? 'private';
  if (!['public', 'private'].includes(visibility)) throw fail('房间类型无效');
  const name = matchmaking ? '12 人标准匹配' : cleanName(data.name, `${session.name}的房间`, 30);
  const room = { code, name, config, visibility, matchmaking, hostId: session.id, players: [], messages: [], game: null, createdAt: now, lastActive: now };
  state.rooms.set(code, room); enter(state, room, session, now, true); return room;
}
function visibleHistory(history, session) { return history.visibility === 'public' || history.players.some(p => p.id === session.id); }
function cleanup(state, now) {
  for (const room of state.rooms.values()) {
    const lastSeen = Math.max(room.lastActive, ...room.players.map(p => sessionById(state, p.id)?.lastSeen ?? 0));
    if (now - lastSeen > 30 * MINUTE) {
      for (const p of room.players) { const s = sessionById(state, p.id); if (s?.roomCode === room.code) s.roomCode = null; }
      state.rooms.delete(room.code); continue;
    }
    if (!room.game) {
      for (const p of [...room.players]) {
        const s = sessionById(state, p.id);
        if (!s || now - s.lastSeen > 2 * MINUTE) dropMember(state, room, s ?? { id: p.id, name: p.name }, now);
      }
    } else if (room.game.phase !== 'finished' && now >= room.game.deadline) advance(room.game, now);
    trimRoom(room);
    recordFinished(state, room, now);
  }
  for (const [key, s] of state.sessions) if (now - s.lastSeen > 24 * HOUR) state.sessions.delete(key);
  for (const [key, b] of state.limits) if (now >= b.until) state.limits.delete(key);
}

function handleState(state, request, body, context) {
  const { now, path, hash, rawToken, newToken, newTokenHash, ipHash } = context;
  cleanup(state, now);
  if (request.method === 'POST' && path === '/api/session') {
    if (rawToken) {
      const s = sessionFor(state, hash, now);
      const name = body.name === undefined ? s.name : cleanName(body.name);
      const room = currentRoom(state, s, false);
      if (name !== s.name && room?.game && room.game.phase !== 'finished') throw fail('对局中不能修改昵称');
      s.name = name;
      if (room && !room.game) room.players.find(p => p.id === s.id).name = name;
      if (state.standings.has(s.id)) state.standings.get(s.id).name = name;
      return { status: 200, body: { token: rawToken, player: { id: s.id, name: s.name } } };
    }
    rate(state, `session:${ipHash}`, 60, HOUR, now);
    if (state.sessions.size >= MAX_SESSIONS) throw fail('当前在线玩家较多，请稍后重试', 503);
    const s = { id: id(), name: cleanName(body.name), roomCode: null, createdAt: now, lastSeen: now };
    state.sessions.set(newTokenHash, s);
    return { status: 201, body: { token: newToken, player: { id: s.id, name: s.name } } };
  }
  const session = sessionFor(state, hash, now);
  if (request.method === 'POST') rate(state, `write:${session.id}`, 90, MINUTE, now);
  let room = currentRoom(state, session, false);
  if (request.method === 'GET') {
    if (path === '/api/room') return { body: { room: serialize(state, room, session, now) } };
    if (path === '/api/rooms') return { body: { rooms: [...state.rooms.values()].filter(r => r.visibility === 'public' && !r.game).map(r => ({ code: r.code, name: r.name, playerCount: r.players.length, capacity: capacity(r), config: r.config, phase: 'waiting', matchmaking: r.matchmaking })) } };
    if (path === '/api/history') return { body: { history: [...state.histories.values()].filter(h => visibleHistory(h, session)).sort((a, b) => b.endedAt - a.endedAt).map(h => ({ code: h.code, name: h.name, winner: h.game.winner, round: h.game.round, endedAt: h.endedAt })) } };
    if (/^\/api\/history\/\d{6}$/.test(path)) {
      const h = state.histories.get(path.split('/').at(-1));
      if (!h || !visibleHistory(h, session)) throw fail('对局记录不存在', 404);
      return { body: { room: { ...h, game: gameView(h.game, session.id) } } };
    }
    if (path === '/api/stats') return { body: { standings: [...state.standings.values()].sort((a, b) => b.wins - a.wins || b.winRate - a.winRate).slice(0, 100) } };
    throw fail('接口不存在', 404);
  }
  if (request.method !== 'POST') throw fail('请求方法不支持', 405);
  switch (path) {
    case '/api/rooms': room = newRoom(state, session, body, now); break;
    case '/api/join': {
      if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw fail('请输入 6 位数字房号');
      room = state.rooms.get(body.code);
      if (!room) throw fail('房间不存在或已经关闭', 404);
      enter(state, room, session, now, room.matchmaking); break;
    }
    case '/api/match': {
      if (room) { if (!room.matchmaking) throw fail('请先退出当前房间再匹配'); break; }
      room = [...state.rooms.values()].filter(r => r.matchmaking && !r.game && r.players.length < capacity(r)).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (room) enter(state, room, session, now, true); else room = newRoom(state, session, {}, now, true);
      break;
    }
    case '/api/leave': {
      if (room) {
        if (room.game && room.game.phase !== 'finished') throw fail('对局进行中，暂时不能退出；刷新页面可重新连接');
        dropMember(state, room, session, now);
      }
      room = null; break;
    }
    case '/api/ready': {
      room = currentRoom(state, session);
      if (room.game) throw fail('游戏已经开始');
      if (room.matchmaking) throw fail('匹配房间自动准备，点击取消匹配可离开');
      if (typeof body.ready !== 'boolean') throw fail('准备状态无效');
      room.players.find(p => p.id === session.id).ready = body.ready; break;
    }
    case '/api/start': {
      room = currentRoom(state, session);
      if (room.hostId !== session.id) throw fail('只有房主可以开始游戏', 403);
      if (room.game) throw fail('游戏已经开始');
      start(room, now); break;
    }
    case '/api/action': {
      room = currentRoom(state, session);
      if (!room.game) throw fail('游戏尚未开始');
      act(room.game, session.id, body, now); break;
    }
    case '/api/chat': {
      room = currentRoom(state, session);
      if (typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > 500) throw fail('消息需为 1–500 个字符');
      rate(state, `chat:${session.id}`, 12, 10000, now);
      const channel = body.channel ?? 'public';
      if (!['public', 'wolf'].includes(channel)) throw fail('聊天频道无效');
      if (room.game ? !canChat(room.game, session.id, channel) : channel !== 'public') throw fail('当前无法在此频道发言，请等待你的发言阶段');
      pushMessage(room, session.name, body.text.trim(), now, session.id, channel); break;
    }
    default: throw fail('接口不存在', 404);
  }
  if (room) { room.lastActive = now; trimRoom(room); recordFinished(state, room, now); }
  return { body: { room: serialize(state, room, session, now) } };
}

/** Fetch-compatible API entry point. The Site worker supplies env.DB. */
export async function handleApi(request, env) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  try {
    const url = new URL(request.url), origin = request.headers.get('Origin');
    const allowed = new Set((env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
    if (origin && origin !== url.origin && !allowed.has(origin)) throw fail('此网站尚未被联机服务允许，请设置 ALLOWED_ORIGINS', 403);
    if (origin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Vary', 'Origin'); }
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Max-Age', '600');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!env.DB?.prepare) throw fail('联机数据库尚未就绪', 503);
    if (request.method === 'GET' && url.pathname === '/api/health') {
      await env.DB.prepare('SELECT id FROM moonwolf_meta LIMIT 1').all();
      return response({ ok: true, service: 'moonwolf', storage: 'd1', version: 2 });
    }
    let body = {};
    if (request.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw fail('请求必须使用 JSON', 415);
      if (Number(request.headers.get('Content-Length') || 0) > 16384) throw fail('请求内容过长', 413);
      const reader = request.body?.getReader();
      let length = 0, chunks = [];
      if (reader) {
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 16384) { await reader.cancel(); throw fail('请求内容过长', 413); } chunks.push(value); }
      }
      const buffer = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
      try { body = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw fail('JSON 请求格式不正确'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('JSON 请求格式不正确');
    }
    const authorization = request.headers.get('Authorization');
    const rawToken = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] || '';
    if (authorization && !rawToken) throw fail('登录状态无效，请重新连接', 401);
    const newToken = !rawToken && url.pathname === '/api/session' ? token() : '';
    const context = {
      now: Date.now(), path: url.pathname, rawToken,
      hash: rawToken ? await digest(rawToken) : '', newToken,
      newTokenHash: newToken ? await digest(newToken) : '',
      ipHash: await digest(request.headers.get('CF-Connecting-IP') || 'local'),
    };
    const result = await withState(env.DB, state => handleState(state, request, body, context));
    return response(result.body, result.status || 200);
  } catch (error) {
    const status = error.status || (error.message?.includes('D1') || error.message?.includes('SQLITE') ? 503 : 400);
    return response({ error: status === 503 && !error.status ? '联机服务暂时不可用，请稍后重试' : error.message || '请求失败，请稍后重试' }, status);
  }
}
