import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { GameRoom } from './room.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8787);
const ROOMS_MAX = 150;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;
const WS_PATH = /^\/api\/rooms\/([A-HJ-NP-Z2-9]{6})\/ws$/;
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['favicon.svg', 'image/svg+xml']]
]);
const json = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
};
const code = () => [...randomBytes(6)].map(b => CHARS[b % CHARS.length]).join('');

function createRoom() {
  const sockets = new Set();
  const storage = new Map();
  let alarmTimer;
  const entry = { ctx: null, room: null, sockets, queue: Promise.resolve(), lastActivity: Date.now() };
  // Serialize all room events to avoid double guesses and out-of-order turn transitions.
  entry.enqueue = task => {
    const next = entry.queue.then(async () => { entry.lastActivity = Date.now(); return task(); });
    entry.queue = next.catch(error => console.error('[room event]', error));
    return next;
  };
  const ctx = {
    ready: Promise.resolve(),
    getWebSockets() { return [...sockets].filter(s => s.readyState === WebSocket.OPEN); },
    blockConcurrencyWhile(fn) { ctx.ready = Promise.resolve().then(fn); },
    storage: {
      async get(key) { return storage.get(key); },
      async put(key, value) { storage.set(key, structuredClone(value)); },
      async setAlarm(at) {
        clearTimeout(alarmTimer);
        alarmTimer = setTimeout(() => entry.enqueue(() => entry.room.alarm()), Math.max(1, at - Date.now()));
        alarmTimer.unref?.();
      },
      async deleteAlarm() { clearTimeout(alarmTimer); alarmTimer = null; }
    }
  };
  entry.ctx = ctx;
  entry.room = new GameRoom(ctx, {});
  return entry;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 3072, perMessageDeflate: false });
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'doodledash', runtime: 'node', version: 2 });
  if (path === '/api/rooms' && req.method === 'POST') {
    if (rooms.size >= ROOMS_MAX) return json(res, 503, { error: 'Too many rooms. Please try later.' });
    let id;
    do { id = code(); } while (rooms.has(id));
    const entry = createRoom();
    rooms.set(id, entry);
    try {
      await entry.ctx.ready;
      entry.room.game.created = true;
      await entry.room.persist();
      return json(res, 201, { code: id });
    } catch (err) {
      rooms.delete(id);
      console.error('[create room]', err);
      return json(res, 500, { error: 'Could not create room' });
    }
  }
  if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  const asset = assets.get(path);
  if (!asset) return json(res, 404, { error: 'Not found' });
  try {
    const content = await readFile(join(PUBLIC, asset[0]));
    res.writeHead(200, {
      'Content-Type': asset[1], 'Cache-Control': path === '/' || path === '/index.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error('[static file]', error);
    json(res, 500, { error: 'Could not load asset' });
  }
});

server.on('upgrade', async (req, socket, head) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const match = WS_PATH.exec(path);
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!match || !host || (origin && new URL(origin).host !== host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const entry = rooms.get(match[1]);
    if (!entry) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    await entry.ctx.ready;
    wss.handleUpgrade(req, socket, head, ws => {
      ws.attachment = null;
      ws.serializeAttachment = data => { ws.attachment = structuredClone(data); };
      ws.deserializeAttachment = () => ws.attachment;
      entry.sockets.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.send(JSON.stringify({ type: 'hello' }));
      ws.on('message', (raw, binary) => {
        if (binary) return;
        const message = raw.toString('utf8');
        entry.enqueue(() => entry.room.webSocketMessage(ws, message));
      });
      ws.on('close', () => entry.enqueue(async () => { entry.sockets.delete(ws); await entry.room.webSocketClose(ws); }));
      ws.on('error', error => console.warn('[websocket]', error.message));
    });
  } catch (error) {
    console.error('[upgrade]', error);
    socket.destroy();
  }
});

const ping = setInterval(() => {
  for (const [id, entry] of rooms) {
    for (const socket of entry.sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.isAlive === false) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
    if (entry.ctx.getWebSockets().length === 0 && Date.now() - entry.lastActivity > ROOM_IDLE_MS) {
      rooms.delete(id);
      entry.ctx.storage.deleteAlarm();
    }
  }
}, 30000);
ping.unref?.();

server.listen(PORT, '0.0.0.0', () => console.log(`DoodleDash listening on port ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
