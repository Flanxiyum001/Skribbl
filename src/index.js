import { GameRoom } from './room.js';
export { GameRoom };

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const roomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, service: 'doodledash', version: 1 });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      // Creating a room is explicit; never silently create arbitrary guesses at existing codes.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = roomCode();
        const id = env.ROOMS.idFromName(code);
        const response = await env.ROOMS.get(id).fetch('https://internal/init', { method: 'POST' });
        if (response.status === 201) return json({ code }, 201);
      }
      return json({ error: 'Could not create a room. Please retry.' }, 503);
    }
    const match = /^\/api\/rooms\/([A-Z2-9]{6})\/ws$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403);
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  }
};
