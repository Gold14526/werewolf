import http from 'node:http';
import { isIP } from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STANDARD_CONFIG, validateConfig, createGame, act, canChat, isWolfRole } from '../web/engine.js';
import { activeRoom, allowAction, capacity, deathTurn, dropMember, enterRoom, gameView, isWatcher, memberships, messagesFor, placeSeat, recoverClock, requireSeat, selectRoom, synchronizeSeats, updateRoom } from './room-members.mjs';
import { openPersistence } from './persistence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const MAX_BODY = 16 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const random = () => randomInt(0, 0x100000000) / 0x100000000;
function clientAddress(req) {
  const peer = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return peer;
  // The local reverse proxy sets/appends the client it actually connected to.
  const header = req.headers['x-forwarded-for'];
  const lastHop = typeof header === 'string' && header.split(',').at(-1).trim();
  return lastHop && isIP(lastHop) ? lastHop : peer;
}
const cleanName = (value, fallback, maxLength = 16) => {
  const text = typeof value === 'string' ? value.trim() : fallback;
  if (!text || [...text].length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) throw fail(`名称需为 1–${maxLength} 个字符`);
  return text;
};
function canonicalFile(file) {
  try { return realpathSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonicalFile(parent), path.basename(file));
  }
}

/** SQLite-backed single-process server. Confirmed operations are durable before HTTP success. */
export function createApp(options = {}) {
  const sessions = new Map();
  const rooms = new Map();
  const limits = new Map();
  const histories = new Map();
  const standings = new Map();
  const allowedOrigins = new Set((options.allowedOrigins ?? process.env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean));
  const clock = options.now ?? Date.now;
  const maxRooms = options.maxRooms ?? 1000;
  const maxSessions = options.maxSessions ?? 10000;
  let databasePath = options.databasePath ?? process.env.DATABASE_PATH ?? path.resolve(ROOT, '../data/moonwolf.sqlite');
  if (typeof databasePath !== 'string' || !databasePath.trim()) throw new Error('DATABASE_PATH must name a writable SQLite file');
  if (databasePath !== ':memory:') {
    databasePath = canonicalFile(path.resolve(databasePath));
    const staticRoot = realpathSync(ROOT);
    if (databasePath === staticRoot || databasePath.startsWith(staticRoot + path.sep)) {
      throw new Error('DATABASE_PATH must be outside the public web directory');
    }
  }
  const persistence = openPersistence(databasePath);
  let storageFailure = null;
  let lastCleanup = 0;

  function snapshot() {
    return structuredClone({
      version: 1,
      sessions: [...sessions],
      rooms: [...rooms].map(([code, room]) => [code, { ...room, players: room.players.map(({ session, ...player }) => ({ ...player, sessionId: session.id })) }]),
      histories: [...histories], standings: [...standings],
    });
  }
  function restore(saved) {
    if (saved?.version !== 1 || !['sessions', 'rooms', 'histories', 'standings'].every(key => Array.isArray(saved[key]))) {
      throw new Error('Unsupported or corrupt Moonwolf database snapshot');
    }
    const restoredSessions = new Map(saved.sessions);
    const sessionsById = new Map([...restoredSessions.values()].map(session => [session.id, session]));
    const restoredRooms = new Map(saved.rooms.map(([code, room]) => [code, {
      ...room,
      players: room.players.map(({ sessionId, ...player }) => {
        const session = sessionsById.get(sessionId);
        if (!session || session.id !== player.id) throw new Error('Database room references a missing session');
        return { ...player, session };
      }),
    }]));
    for (const [target, source] of [[sessions, restoredSessions], [rooms, restoredRooms], [histories, saved.histories], [standings, saved.standings]]) {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    }
  }
  function storageUnavailable(error) {
    if (!storageFailure) console.error('Durable storage failed:', error.message);
    storageFailure ??= fail('持久化存储不可用，操作未确认；请修复存储并重启服务', 503);
    return storageFailure;
  }
  function ensureStorage() {
    if (storageFailure) throw storageFailure;
    try { persistence.assertCurrent(); } catch (error) { throw storageUnavailable(error); }
  }
  function checkpoint(now = clock()) {
    if (storageFailure) throw storageFailure;
    try { persistence.save(snapshot(), now); } catch (error) { throw storageUnavailable(error); }
  }
  function transaction(action) {
    ensureStorage();
    const before = snapshot();
    try { const result = action(); checkpoint(); return result; }
    catch (error) { restore(before); throw error; }
  }
  try {
    if (persistence.loaded) {
      restore(persistence.loaded.snapshot);
      const now = clock();
      const paused = Math.max(0, now - persistence.loaded.savedAt);
      // Freeze offline time at the last durable checkpoint. Historical timestamps
      // remain unchanged; only expiry clocks and the current stage are resumed.
      for (const session of sessions.values()) {
        session.lastSeen += paused;
        session.recoveryUntil = now + 2 * MINUTE;
      }
      for (const room of rooms.values()) {
        room.lastActive += paused;
        room.recoveryUntil = now + 2 * MINUTE;
        recoverClock(room.game, persistence.loaded.savedAt, now);
        refresh(room, now);
      }
    }
    // Claim a new revision on startup. Another process holding an older
    // snapshot can no longer write it over this instance's state.
    checkpoint();
  } catch (error) { persistence.close(); throw error; }

  function rate(key, count, window, now) {
    if (options.disableRateLimits) return;
    let bucket = limits.get(key);
    if (!bucket || now >= bucket.until) limits.set(key, bucket = { count: 0, until: now + window });
    if (++bucket.count > count) throw fail('操作太频繁，请稍后再试', 429);
  }
  function sessionFor(req, now) {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const session = token && sessions.get(token);
    if (!session || (now >= (session.recoveryUntil ?? 0) && now - session.lastSeen > 24 * HOUR)) throw fail('登录状态已过期，请重新填写昵称', 401);
    session.lastSeen = now;
    rate(`user:${session.id}`, 240, MINUTE, now);
    return session;
  }
  function pushMessage(room, name, text, playerId = null, channel = 'public') {
    room.messages.push({ id: randomBytes(8).toString('hex'), playerId, seat: room.players.find(p => p.id === playerId)?.seat, name, text, channel, at: clock(), system: playerId === null });
    if (room.messages.length > 2000) room.messages.splice(0, room.messages.length - 2000);
  }
  function announce(room) { return text => pushMessage(room, '系统', text); }
  function refresh(room, now) { updateRoom(room, now, announce(room)); }
  function serialize(room, session, now) {
    if (!room) return null;
    return {
      code: room.code, name: room.name, hostId: room.hostId, visibility: room.visibility,
      isSpectator: isWatcher(room, session.id), matchmaking: room.matchmaking, config: room.config, createdAt: room.createdAt,
      players: room.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, ready: p.ready, connected: now - p.session.lastSeen < 45 * SECOND })),
      messages: messagesFor(room, session.id, isWatcher(room, session.id)),
      game: room.game ? gameView(room.game, session.id, isWatcher(room, session.id)) : null,
    };
  }
  function recordFinished(room, now) {
    if (!room.game || room.game.phase !== 'finished' || room.recorded) return;
    room.recorded = true;
    const snapshot = {
      code: room.code, name: room.name, hostId: room.hostId, visibility: room.visibility,
      matchmaking: room.matchmaking, config: structuredClone(room.config), createdAt: room.createdAt, endedAt: now,
      players: room.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, ready: p.ready, connected: false })),
      messages: structuredClone(room.messages), game: structuredClone(room.game),
    };
    histories.set(room.code, snapshot);
    while (histories.size > 100) histories.delete(histories.keys().next().value);
    for (const player of room.game.players) {
      let stat = standings.get(player.id);
      if (!stat) standings.set(player.id, stat = { id: player.id, name: player.name, wins: 0, games: 0, winRate: 0 });
      stat.games++;
      if ((isWolfRole(player.role) ? 'wolf' : 'good') === room.game.winner) stat.wins++;
      stat.winRate = Math.round(stat.wins / stat.games * 100);
    }
  }
  function visibleHistory(history, session) {
    return history.visibility === 'public' || history.players.some(p => p.id === session.id);
  }
  function historyView(history, session) {
    const spectator = !history.players.some(p => p.id === session.id);
    return { ...history, isSpectator: spectator, messages: messagesFor(history, session.id, spectator), game: gameView(history.game, session.id, spectator) };
  }
  function start(room, now) {
    if (room.players.length !== capacity(room)) throw fail('人数未满，暂时不能开始');
    if (!room.players.every(p => p.ready)) throw fail('还有玩家未准备');
    room.game = createGame(room.players.map(({ id, name, seat }) => ({ id, name, seat })), room.config, { now, random });
    synchronizeSeats(room);
    pushMessage(room, '系统', '对局开始，天黑请闭眼。');
  }
  function enter(room, session, now, autoReady = false) {
    enterRoom(rooms, room, session, autoReady, { session }, announce(room));
    room.lastActive = now;
    if (!room.game && room.matchmaking && room.players.length === capacity(room)) start(room, now);
  }
  function newRoom(session, data, now, matchmaking = false) {
    if (activeRoom(rooms, session.id)) throw fail('请先离开当前玩家席');
    if (rooms.size >= maxRooms) throw fail('服务器房间已满，请稍后再试', 503);
    const config = validateConfig(matchmaking ? STANDARD_CONFIG : data.config ?? STANDARD_CONFIG);
    let code;
    for (let attempt = 0; attempt < 100; attempt++) {
      code = String(randomInt(100000, 1000000));
      if (!rooms.has(code) && !histories.has(code)) break;
      code = null;
    }
    if (!code) throw fail('暂时无法分配房号，请重试', 503);
    const visibility = matchmaking ? 'public' : data.visibility ?? 'private';
    if (!['public', 'private'].includes(visibility)) throw fail('房间类型无效');
    const room = { code, name: matchmaking ? '12 人标准匹配' : cleanName(data.name, `${session.name}的房间`, 30), config, visibility, matchmaking, hostId: session.id, players: [], messages: [], game: null, createdAt: now, lastActive: now };
    rooms.set(code, room);
    enter(room, session, now, true);
    return room;
  }
  function cleanup(now) {
    let sessionsById;
    for (const room of rooms.values()) {
      refresh(room, now);
      recordFinished(room, now);
      let lastSeen = Math.max(room.lastActive, ...room.players.filter(p => !p.retired).map(p => p.session.lastSeen));
      for (const id of [...(room.spectators ?? [])]) {
        sessionsById ??= new Map([...sessions.values()].map(s => [s.id, s]));
        const spectator = sessionsById.get(id);
        lastSeen = Math.max(lastSeen, spectator?.lastSeen ?? 0);
        if (spectator && now >= (spectator.recoveryUntil ?? 0) && now - spectator.lastSeen > 2 * MINUTE) dropMember(rooms, room, spectator, announce(room));
      }
      if (now >= (room.recoveryUntil ?? 0) && now - lastSeen > 30 * MINUTE) {
        for (const s of sessions.values()) if (s.roomCode === room.code) s.roomCode = null;
        rooms.delete(room.code);
      } else if (!room.game) {
        for (const player of [...room.players]) if (now >= (player.session.recoveryUntil ?? 0) && now - player.session.lastSeen > 2 * MINUTE) dropMember(rooms, room, player.session, announce(room));
      }
    }
    if (now - lastCleanup > MINUTE) {
      const retained = new Set([...rooms.values()].flatMap(room => room.players.map(p => p.id)));
      for (const [token, session] of sessions) if (now - session.lastSeen > 24 * HOUR && now >= (session.recoveryUntil ?? 0) && !retained.has(session.id) && !rooms.has(session.roomCode)) sessions.delete(token);
      for (const [key, bucket] of limits) if (now >= bucket.until) limits.delete(key);
      lastCleanup = now;
    }
  }
  const timer = setInterval(() => {
    if (storageFailure) return;
    try { transaction(() => cleanup(clock())); } catch (error) { console.error('Game timer failed:', error.message); }
  }, SECOND);
  timer.unref();

  async function readBody(req) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw fail('请求必须使用 JSON', 415);
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw fail('请求内容过长', 413);
      chunks.push(chunk);
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('JSON 请求格式不正确');
      return data;
    } catch { throw fail('JSON 请求格式不正确'); }
  }
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    let pendingSnapshot = null;
    const respond = (status, body) => {
      // No await is permitted between snapshotting state, mutating it and this
      // synchronous commit: concurrent HTTP bodies cannot interleave updates.
      checkpoint();
      pendingSnapshot = null;
      return send(res, status, body);
    };
    try {
      let now = clock();
      const url = new URL(req.url, 'http://localhost');
      const isApi = url.pathname.startsWith('/api/');
      if (isApi) {
        const origin = req.headers.origin;
        let sameOrigin = false;
        try { sameOrigin = new URL(origin).host === req.headers.host; } catch {}
        if (origin && !sameOrigin && !allowedOrigins.has(origin)) throw fail('此网站尚未被联机服务允许，请设置 ALLOWED_ORIGINS', 403);
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        ensureStorage();
        const address = clientAddress(req);
        rate(`ip:${address}`, 2400, MINUTE, now);
        if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, version: 1, service: 'moonwolf' });
        const body = req.method === 'POST' ? await readBody(req) : {};
        ensureStorage();
        now = clock();
        pendingSnapshot = snapshot();
        if (req.method === 'POST' && url.pathname === '/api/session') {
          if (req.headers.authorization) {
            const session = sessionFor(req, now);
            const name = body.name === undefined ? session.name : cleanName(body.name);
            const playing = activeRoom(rooms, session.id);
            if (name !== session.name && playing?.game) throw fail('对局中不能修改昵称');
            session.name = name;
            if (playing && !playing.game) playing.players.find(p => p.id === session.id).name = name;
            if (standings.has(session.id)) standings.get(session.id).name = name;
            return respond(200, { token: req.headers.authorization.slice(7), player: { id: session.id, name } });
          }
          rate(`session:${address}`, 60, HOUR, now);
          if (sessions.size >= maxSessions) throw fail('服务器人数已满，请稍后再试', 503);
          const name = cleanName(body.name);
          const token = randomBytes(32).toString('base64url');
          const session = { id: randomBytes(12).toString('hex'), name, roomCode: null, createdAt: now, lastSeen: now };
          sessions.set(token, session);
          return respond(201, { token, player: { id: session.id, name } });
        }
        const session = sessionFor(req, now);
        if (req.method === 'POST') {
          const typing = url.pathname === '/api/action' && body.type === 'typing';
          rate(`${typing ? 'typing' : 'write'}:${session.id}`, typing ? 60 : 90, MINUTE, now);
        }
        let room = selectRoom(rooms, session, url.searchParams.get('code'), false);
        if (room) { room.lastActive = now; refresh(room, now); recordFinished(room, now); }
        if (req.method === 'GET' && url.pathname === '/api/room') return respond(200, { room: serialize(room, session, now), memberships: memberships(rooms, session.id) });
        if (req.method === 'GET' && url.pathname === '/api/rooms') {
          return respond(200, { rooms: [...rooms.values()].filter(r => r.visibility === 'public' && !r.game).slice(0, 100).map(r => ({ code: r.code, name: r.name, playerCount: r.players.length, capacity: capacity(r), config: r.config, phase: 'waiting', matchmaking: r.matchmaking })) });
        }
        if (req.method === 'GET' && url.pathname === '/api/history') {
          return respond(200, { history: [...histories.values()].filter(h => visibleHistory(h, session)).reverse().map(h => ({ code: h.code, name: h.name, winner: h.game.winner, round: h.game.round, endedAt: h.endedAt })) });
        }
        if (req.method === 'GET' && /^\/api\/history\/\d{6}$/.test(url.pathname)) {
          const history = histories.get(url.pathname.split('/').pop());
          if (!history || !visibleHistory(history, session)) throw fail('对局记录不存在', 404);
          return respond(200, { room: historyView(history, session) });
        }
        if (req.method === 'GET' && url.pathname === '/api/stats') {
          return respond(200, { standings: [...standings.values()].sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 100) });
        }
        if (req.method !== 'POST') throw fail('接口不存在', 404);
        switch (url.pathname) {
          case '/api/rooms': room = newRoom(session, body, now); break;
          case '/api/join': {
            if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw fail('请输入 6 位数字房号');
            room = rooms.get(body.code);
            if (!room) throw fail('房间不存在或已经关闭', 404);
            enter(room, session, now, room.matchmaking);
            break;
          }
          case '/api/match': {
            room = activeRoom(rooms, session.id);
            if (room) {
              if (!room.matchmaking) throw fail('请先退出当前房间再匹配');
              session.roomCode = room.code;
              break;
            }
            room = [...rooms.values()].find(r => r.matchmaking && !r.game && r.players.length < capacity(r));
            if (room && isWatcher(room, session.id)) {
              let seat = 1;
              while (room.players.some(p => p.seat === seat)) seat++;
              placeSeat(rooms, room, session, seat, true, { session }, announce(room));
            }
            if (room) enter(room, session, now, true);
            else room = newRoom(session, {}, now, true);
            break;
          }
          case '/api/leave':
            if (room) dropMember(rooms, room, session, announce(room));
            room = null; break;
          case '/api/seat': {
            if (!room) throw fail('请先进入房间', 404);
            placeSeat(rooms, room, session, body.seat, room.matchmaking, { session }, announce(room));
            if (room.matchmaking && room.players.length === capacity(room)) start(room, now);
            break;
          }
          case '/api/ready': {
            if (!room) throw fail('请先进入房间', 404);
            requireSeat(room, session.id);
            if (room.game) throw fail('游戏已经开始');
            if (room.matchmaking) throw fail('匹配房间自动准备，点击取消匹配可离开');
            if (typeof body.ready !== 'boolean') throw fail('准备状态无效');
            room.players.find(p => p.id === session.id).ready = body.ready;
            break;
          }
          case '/api/start': {
            if (!room) throw fail('请先进入房间', 404);
            if (room.hostId !== session.id) throw fail('只有房主可以开始游戏', 403);
            if (room.game) throw fail('游戏已经开始');
            start(room, now);
            break;
          }
          case '/api/action': {
            if (!room) throw fail('请先进入房间', 404);
            if (!room.game) throw fail('游戏尚未开始');
            allowAction(room, session.id, body.type);
            act(room.game, session.id, body, now);
            break;
          }
          case '/api/chat': {
            if (!room) throw fail('请先进入房间', 404);
            if (typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > 500) throw fail('消息需为 1–500 个字符');
            rate(`chat:${session.id}`, 12, 10 * SECOND, now);
            const channel = body.channel ?? 'public';
            if (!['public', 'wolf'].includes(channel)) throw fail('聊天频道无效');
            if (!deathTurn(room.game, session.id)) requireSeat(room, session.id);
            if (room.game ? !canChat(room.game, session.id, channel) : channel !== 'public') throw fail('当前无法在此频道发言，请等待你的发言阶段');
            if (channel === 'public' && room.game?.currentSpeakerId === session.id && room.game.phase !== 'finished') act(room.game, session.id, { type: 'typing' }, now);
            pushMessage(room, session.name, body.text.trim(), session.id, channel);
            break;
          }
          default: throw fail('接口不存在', 404);
        }
        if (room) { refresh(room, now); recordFinished(room, now); }
        return respond(200, { room: serialize(room, session, now), memberships: memberships(rooms, session.id) });
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fail('请求方法不支持', 405);
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw fail('路径格式不正确'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(x => x.startsWith('.'))) throw fail('页面不存在', 404);
      const target = path.resolve(ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!target.startsWith(ROOT + path.sep)) throw fail('页面不存在', 404);
      let info;
      try { info = await stat(target); } catch { throw fail('页面不存在', 404); }
      if (!info.isFile()) throw fail('页面不存在', 404);
      const actualTarget = await realpath(target);
      if (!actualTarget.startsWith(realpathSync(ROOT) + path.sep)) throw fail('页面不存在', 404);
      const contents = await readFile(actualTarget);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': contents.length });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (pendingSnapshot) restore(pendingSnapshot);
      const status = error.status ?? 400;
      if (!res.headersSent) send(res, status, { error: error.message || '请求失败，请稍后重试' });
      else res.end();
    }
  }
  const server = http.createServer(handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let closePromise;
  return {
    server,
    listen: (...args) => server.listen(...args),
    close: () => closePromise ??= new Promise((resolve, reject) => {
      clearInterval(timer);
      server.close(error => {
        try { persistence.close(); } catch (closeError) { error ??= closeError; }
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
      });
      server.closeIdleConnections();
    }),
    // Test-only observability is available to code importing the server, never over HTTP.
    state: { sessions, rooms, histories, standings },
    tick: () => transaction(() => cleanup(clock())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen(port, host, () => console.log(`Moonwolf listening on http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
