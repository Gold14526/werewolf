import http from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STANDARD_CONFIG, validateConfig, createGame, act, advance, viewGame, canChat } from '../web/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const MAX_BODY = 16 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const random = () => randomInt(0, 0x100000000) / 0x100000000;
const cleanName = (value, fallback, maxLength = 16) => {
  const text = typeof value === 'string' ? value.trim() : fallback;
  if (!text || [...text].length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) throw fail(`名称需为 1–${maxLength} 个字符`);
  return text;
};

/** In-memory single-process game server. Call app.close() during tests/shutdown. */
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
  let lastCleanup = 0;

  function rate(key, count, window, now) {
    if (options.disableRateLimits) return;
    let bucket = limits.get(key);
    if (!bucket || now >= bucket.until) limits.set(key, bucket = { count: 0, until: now + window });
    if (++bucket.count > count) throw fail('操作太频繁，请稍后再试', 429);
  }
  const capacity = room => Object.values(room.config.roles).reduce((a, b) => a + b, 0);
  function sessionFor(req, now) {
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const session = token && sessions.get(token);
    if (!session || now - session.lastSeen > 24 * HOUR) throw fail('登录状态已过期，请重新填写昵称', 401);
    session.lastSeen = now;
    rate(`user:${session.id}`, 240, MINUTE, now);
    return session;
  }
  function currentRoom(session, required = true) {
    const room = session.roomCode && rooms.get(session.roomCode);
    if (!room) {
      session.roomCode = null;
      if (required) throw fail('请先进入房间', 404);
      return null;
    }
    return room;
  }
  function pushMessage(room, name, text, playerId = null, channel = 'public') {
    room.messages.push({ id: randomBytes(8).toString('hex'), playerId, name, text, channel, at: clock(), system: playerId === null });
    if (room.messages.length > 2000) room.messages.splice(0, room.messages.length - 2000);
  }
  function dropMember(room, session) {
    const index = room.players.findIndex(p => p.id === session.id);
    if (index !== -1) {
      room.players.splice(index, 1);
      pushMessage(room, '系统', `${session.name} 离开了房间`);
    }
    if (session.roomCode === room.code) session.roomCode = null;
    if (!room.players.length) rooms.delete(room.code);
    else if (room.hostId === session.id) {
      room.hostId = room.players[0].id;
      room.players[0].ready = true;
      pushMessage(room, '系统', `${room.players[0].name} 成为新房主`);
    }
  }
  function leave(session) {
    const room = currentRoom(session, false);
    if (!room) return;
    if (room.game && room.game.phase !== 'finished') throw fail('对局进行中，暂时不能退出；刷新页面可重新连接');
    dropMember(room, session);
  }
  function serialize(room, session, now) {
    if (!room) return null;
    return {
      code: room.code, name: room.name, hostId: room.hostId, visibility: room.visibility,
      matchmaking: room.matchmaking, config: room.config, createdAt: room.createdAt,
      players: room.players.map(p => ({ id: p.id, name: p.name, seat: p.seat, ready: p.ready, connected: now - p.session.lastSeen < 45 * SECOND })),
      messages: room.messages.filter(message => message.channel !== 'wolf' || room.game?.phase === 'finished' || room.game?.players.find(p => p.id === session.id)?.role === 'wolf'),
      game: room.game ? gameView(room.game, session.id) : null,
    };
  }
  function gameView(game, viewerId) {
    const member = game.players.find(p => p.id === viewerId);
    if (!member && game.phase !== 'finished') throw fail('你不在这个房间中', 403);
    const view = viewGame(game, member ? viewerId : game.players[0].id);
    if (!member) { view.myRole = null; view.privateInfo = {}; }
    return view;
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
      if ((player.role === 'wolf' ? 'wolf' : 'good') === room.game.winner) stat.wins++;
      stat.winRate = Math.round(stat.wins / stat.games * 100);
    }
  }
  function visibleHistory(history, session) {
    return history.visibility === 'public' || history.players.some(p => p.id === session.id);
  }
  function historyView(history, session) {
    return { ...history, game: gameView(history.game, session.id) };
  }
  function start(room, now) {
    if (room.players.length !== capacity(room)) throw fail('人数未满，暂时不能开始');
    if (!room.players.every(p => p.ready)) throw fail('还有玩家未准备');
    room.game = createGame(room.players.map(({ id, name, seat }) => ({ id, name, seat })), room.config, { now, random });
    pushMessage(room, '系统', '对局开始，天黑请闭眼。');
  }
  function enter(room, session, now, autoReady = false) {
    const existing = currentRoom(session, false);
    if (existing) {
      if (existing.code === room.code) return;
      throw fail('你已在其他房间中，请先退出当前房间');
    }
    if (room.game) throw fail('该房间已经开始游戏');
    if (room.players.length >= capacity(room)) throw fail('房间已满');
    const used = new Set(room.players.map(p => p.seat));
    let seat = 1;
    while (used.has(seat)) seat++;
    room.players.push({ id: session.id, name: session.name, seat, ready: autoReady, session });
    session.roomCode = room.code;
    room.lastActive = now;
    pushMessage(room, '系统', `${session.name} 加入了房间`);
    if (room.matchmaking && room.players.length === capacity(room)) start(room, now);
  }
  function newRoom(session, data, now, matchmaking = false) {
    if (currentRoom(session, false)) throw fail('请先退出当前房间');
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
    for (const room of rooms.values()) {
      if (room.game && room.game.phase !== 'finished') advance(room.game, now);
      recordFinished(room, now);
      const lastSeen = Math.max(room.lastActive, ...room.players.map(p => p.session.lastSeen));
      if (now - lastSeen > 30 * MINUTE) {
        for (const player of room.players) if (player.session.roomCode === room.code) player.session.roomCode = null;
        rooms.delete(room.code);
      } else if (!room.game) {
        for (const player of [...room.players]) if (now - player.session.lastSeen > 2 * MINUTE) dropMember(room, player.session);
      }
    }
    if (now - lastCleanup > MINUTE) {
      for (const [token, session] of sessions) if (now - session.lastSeen > 24 * HOUR) sessions.delete(token);
      for (const [key, bucket] of limits) if (now >= bucket.until) limits.delete(key);
      lastCleanup = now;
    }
  }
  const timer = setInterval(() => {
    try { cleanup(clock()); } catch (error) { console.error('Game timer failed:', error.message); }
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
    try {
      const now = clock();
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
        rate(`ip:${req.socket.remoteAddress}`, 2400, MINUTE, now);
        if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, version: 1, service: 'moonwolf' });
        const body = req.method === 'POST' ? await readBody(req) : {};
        if (req.method === 'POST' && url.pathname === '/api/session') {
          if (req.headers.authorization) {
            const session = sessionFor(req, now);
            const name = body.name === undefined ? session.name : cleanName(body.name);
            const room = currentRoom(session, false);
            if (name !== session.name && room?.game && room.game.phase !== 'finished') throw fail('对局中不能修改昵称');
            session.name = name;
            if (room && !room.game) room.players.find(p => p.id === session.id).name = name;
            if (standings.has(session.id)) standings.get(session.id).name = name;
            return send(res, 200, { token: req.headers.authorization.slice(7), player: { id: session.id, name } });
          }
          rate(`session:${req.socket.remoteAddress}`, 60, HOUR, now);
          if (sessions.size >= maxSessions) throw fail('服务器人数已满，请稍后再试', 503);
          const name = cleanName(body.name);
          const token = randomBytes(32).toString('base64url');
          const session = { id: randomBytes(12).toString('hex'), name, roomCode: null, createdAt: now, lastSeen: now };
          sessions.set(token, session);
          return send(res, 201, { token, player: { id: session.id, name } });
        }
        const session = sessionFor(req, now);
        if (req.method === 'POST') rate(`write:${session.id}`, 90, MINUTE, now);
        let room = currentRoom(session, false);
        if (room) { room.lastActive = now; if (room.game) advance(room.game, now); recordFinished(room, now); }
        if (req.method === 'GET' && url.pathname === '/api/room') return send(res, 200, { room: serialize(room, session, now) });
        if (req.method === 'GET' && url.pathname === '/api/rooms') {
          return send(res, 200, { rooms: [...rooms.values()].filter(r => r.visibility === 'public' && !r.game).slice(0, 100).map(r => ({ code: r.code, name: r.name, playerCount: r.players.length, capacity: capacity(r), config: r.config, phase: 'waiting', matchmaking: r.matchmaking })) });
        }
        if (req.method === 'GET' && url.pathname === '/api/history') {
          return send(res, 200, { history: [...histories.values()].filter(h => visibleHistory(h, session)).reverse().map(h => ({ code: h.code, name: h.name, winner: h.game.winner, round: h.game.round, endedAt: h.endedAt })) });
        }
        if (req.method === 'GET' && /^\/api\/history\/\d{6}$/.test(url.pathname)) {
          const history = histories.get(url.pathname.split('/').pop());
          if (!history || !visibleHistory(history, session)) throw fail('对局记录不存在', 404);
          return send(res, 200, { room: historyView(history, session) });
        }
        if (req.method === 'GET' && url.pathname === '/api/stats') {
          return send(res, 200, { standings: [...standings.values()].sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || a.name.localeCompare(b.name, 'zh-CN')).slice(0, 100) });
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
            if (room) {
              if (!room.matchmaking) throw fail('请先退出当前房间再匹配');
              break;
            }
            room = [...rooms.values()].find(r => r.matchmaking && !r.game && r.players.length < capacity(r));
            if (room) enter(room, session, now, true);
            else room = newRoom(session, {}, now, true);
            break;
          }
          case '/api/leave': leave(session); room = null; break;
          case '/api/ready': {
            room = currentRoom(session);
            if (room.game) throw fail('游戏已经开始');
            if (room.matchmaking) throw fail('匹配房间自动准备，点击取消匹配可离开');
            if (typeof body.ready !== 'boolean') throw fail('准备状态无效');
            room.players.find(p => p.id === session.id).ready = body.ready;
            break;
          }
          case '/api/start': {
            room = currentRoom(session);
            if (room.hostId !== session.id) throw fail('只有房主可以开始游戏', 403);
            if (room.game) throw fail('游戏已经开始');
            start(room, now);
            break;
          }
          case '/api/action': {
            room = currentRoom(session);
            if (!room.game) throw fail('游戏尚未开始');
            act(room.game, session.id, body, now);
            break;
          }
          case '/api/chat': {
            room = currentRoom(session);
            if (typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > 500) throw fail('消息需为 1–500 个字符');
            rate(`chat:${session.id}`, 12, 10 * SECOND, now);
            const channel = body.channel ?? 'public';
            if (!['public', 'wolf'].includes(channel)) throw fail('聊天频道无效');
            if (room.game ? !canChat(room.game, session.id, channel) : channel !== 'public') throw fail('当前无法在此频道发言，请等待你的发言阶段');
            pushMessage(room, session.name, body.text.trim(), session.id, channel);
            break;
          }
          default: throw fail('接口不存在', 404);
        }
        if (room) recordFinished(room, now);
        return send(res, 200, { room: serialize(room, session, now) });
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
      const contents = await readFile(target);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Length': contents.length });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      const status = error.status ?? 400;
      if (!res.headersSent) send(res, status, { error: error.message || '请求失败，请稍后重试' });
      else res.end();
    }
  }
  const server = http.createServer(handler);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    listen: (...args) => server.listen(...args),
    close: () => new Promise((resolve, reject) => { clearInterval(timer); server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
    // Test-only observability is available to code importing the server, never over HTTP.
    state: { sessions, rooms, histories, standings },
    tick: () => cleanup(clock()),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  app.listen(port, host, () => console.log(`Moonwolf listening on http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
