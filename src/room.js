import { DurableObject } from './durable-shim.js';
import { pickWords, normalizeGuess, hiddenWord } from './words.js';

const MAX_PLAYERS = 12;
const MAX_STROKES = 3500;
const COLOR_SET = new Set(['#ffffff','#000000','#f87171','#fb923c','#fbbf24','#a3e635','#34d399','#2dd4bf','#38bdf8','#818cf8','#c084fc','#f472b6','#787c91','#b45309']);
const defaultGame = () => ({
  created: false, host: null, players: [], phase: 'lobby', settings: { rounds: 3, seconds: 80 },
  round: 0, turn: 0, order: [], drawer: null, options: [], answer: '', lastWord: '', hintStage: 0,
  endsAt: 0, hintCount: 0, strokes: [], messages: [], guessedCount: 0
});
const safeName = (s) => String(s || 'Guest').trim().replace(/[<>\x00-\x1f]/g, '').slice(0, 18) || 'Guest';
const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* connection may have dropped */ } };
const live = (p) => p && p.connected;

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = defaultGame();
    this.pendingStrokes = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.game = await ctx.storage.get('game') || defaultGame();
      // Recover active connections after WebSocket hibernation and reject stale sessions.
      const online = new Set(ctx.getWebSockets().map(ws => ws.deserializeAttachment()?.pid).filter(Boolean));
      for (const player of this.game.players) player.connected = online.has(player.id);
    });
  }

  async persist() { await this.ctx.storage.put('game', this.game); }
  socketFor(pid) {
    return this.ctx.getWebSockets().find(ws => ws.deserializeAttachment()?.pid === pid);
  }
  broadcast(event) { for (const ws of this.ctx.getWebSockets()) send(ws, event); }
  announce(text, kind = 'system') {
    this.game.messages.push({ type: 'system', text, kind, time: Date.now() });
    this.game.messages = this.game.messages.slice(-45);
    this.broadcast({ type: 'message', message: this.game.messages.at(-1) });
  }
  stateFor(pid) {
    const g = this.game;
    const me = g.players.find(p => p.id === pid);
    const canSeeWord = g.phase === 'reveal' || g.phase === 'ended' || (g.phase === 'drawing' && (g.drawer === pid || me?.guessed));
    return {
      type: 'state', phase: g.phase, host: g.host,
      me: pid, round: g.round, turn: g.turn, totalTurns: g.order.length * g.settings.rounds,
      drawer: g.drawer, endsAt: g.endsAt, settings: g.settings,       word: canSeeWord ? (g.phase === 'reveal' ? g.lastWord : g.answer) : null,
      masked: g.phase === 'drawing' ? hiddenWord(g.answer, g.hintCount) : '',
      wordLength: g.answer.length, options: g.phase === 'choosing' && g.drawer === pid ? g.options : [],
      players: g.players.map(({ id, name, score, connected, guessed }) => ({ id, name, score, connected, guessed, spectator: g.phase !== 'lobby' && !g.order.includes(id) })),
      strokes: g.strokes, messages: g.messages
    };
  }
  sync() {
    for (const ws of this.ctx.getWebSockets()) {
      const pid = ws.deserializeAttachment()?.pid;
      if (pid) send(ws, this.stateFor(pid));
    }
  }
  async setPhase(phase, seconds = 0) {
    this.game.phase = phase;
    this.game.endsAt = seconds ? Date.now() + seconds * 1000 : 0;
    if (this.game.endsAt) await this.ctx.storage.setAlarm(this.game.endsAt);
    else await this.ctx.storage.deleteAlarm();
    await this.persist();
    this.sync();
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.game.created) return new Response('exists', { status: 409 });
      this.game.created = true;
      await this.persist();
      return new Response('created', { status: 201 });
    }
    if (!this.game.created) return new Response('Room not found', { status: 404 });
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Upgrade required', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    send(server, { type: 'hello' });
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 3072) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    let attachment = ws.deserializeAttachment() || {};
    if (m.type === 'join') {
      if (attachment.pid) return;
      const token = typeof m.token === 'string' && /^[a-f0-9-]{36}$/i.test(m.token) ? m.token : crypto.randomUUID();
      let player = this.game.players.find(p => p.token === token);
      if (!player) {
        if (this.game.players.filter(live).length >= MAX_PLAYERS) { send(ws, { type: 'error', message: 'This room is full (12 players).' }); ws.close(1008, 'room full'); return; }
        player = { id: crypto.randomUUID(), token, name: safeName(m.name), score: 0, guessed: false, connected: true };
        this.game.players.push(player);
      } else {
        const oldSocket = this.socketFor(player.id);
        if (oldSocket && oldSocket !== ws) { send(oldSocket, { type: 'error', message: 'This session opened in another tab.' }); oldSocket.close(1000, 'session moved'); }
        player.connected = true;
        // Keep original name and score stable across reconnects.
      }
      ws.serializeAttachment({ pid: player.id, chatAt: 0, strokeAt: 0, strokeBurst: 0 });
      if (!this.game.host || !this.game.players.some(p => p.id === this.game.host && p.connected)) this.game.host = player.id;
      send(ws, { type: 'joined', id: player.id, token });
      this.announce(`${player.name} joined the room`);
      await this.persist();
      this.sync();
      return;
    }
    const pid = attachment.pid;
    const player = this.game.players.find(p => p.id === pid && p.connected);
    if (!player) return;
    const g = this.game;
    if (m.type === 'settings' && g.host === pid && (g.phase === 'lobby' || g.phase === 'ended')) {
      g.settings.rounds = Math.max(1, Math.min(6, Number.isFinite(+m.rounds) ? Math.floor(+m.rounds) : 3));
      g.settings.seconds = Math.max(45, Math.min(120, Number.isFinite(+m.seconds) ? Math.floor(+m.seconds) : 80));
      await this.persist(); this.sync(); return;
    }
    if (m.type === 'start' && g.host === pid && (g.phase === 'lobby' || g.phase === 'ended')) {
      const active = g.players.filter(live);
      if (active.length < 2) { send(ws, { type: 'error', message: 'You need at least 2 players to start.' }); return; }
      g.players = active;
      for (const p of g.players) { p.score = 0; p.guessed = false; }
      g.order = active.map(p => p.id).sort(() => Math.random() - 0.5);
      g.turn = 0; g.round = 0; g.lastWord = ''; g.messages = [];
      await this.nextTurn(); return;
    }
    if (m.type === 'choose' && g.phase === 'choosing' && g.drawer === pid && g.options.includes(m.word)) {
      await this.beginDrawing(m.word); return;
    }
    if (m.type === 'stroke' && g.phase === 'drawing' && g.drawer === pid) {
      const now = Date.now();
      attachment.strokeBurst = now - (attachment.strokeAt || 0) > 1000 ? 0 : attachment.strokeBurst || 0;
      attachment.strokeBurst++;
      if (attachment.strokeBurst > 50 || g.strokes.length >= MAX_STROKES) return;
      attachment.strokeAt = now;
      ws.serializeAttachment(attachment);
      const { p, color, size } = m;
      if (!Array.isArray(p) || p.length !== 4 || p.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) return;
      if (!COLOR_SET.has(color) || !Number.isInteger(size) || size < 2 || size > 30) return;
      const stroke = { p, color, size };
      g.strokes.push(stroke);
      this.broadcast({ type: 'stroke', stroke });
      // Batch persistence to keep the free-tier Durable Objects write quota reasonable.
      if (++this.pendingStrokes >= 12) { this.pendingStrokes = 0; await this.persist(); }
      return;
    }
    if (m.type === 'clear' && g.phase === 'drawing' && g.drawer === pid) {
      g.strokes = []; this.pendingStrokes = 0;
      await this.persist(); this.broadcast({ type: 'clear' }); return;
    }
    if (m.type === 'chat' && typeof m.text === 'string') {
      const text = m.text.trim().slice(0, 120);
      if (!text || Date.now() - (attachment.chatAt || 0) < 500) return;
      attachment.chatAt = Date.now(); ws.serializeAttachment(attachment);
      if (g.phase === 'drawing' && pid !== g.drawer && !player.guessed && g.order.includes(pid)) {
        if (normalizeGuess(text) === normalizeGuess(g.answer)) {
          player.guessed = true;
          const remaining = Math.max(0, (g.endsAt - Date.now()) / (g.settings.seconds * 1000));
          player.score += Math.round(100 + remaining * 400 + (g.guessedCount === 0 ? 75 : 0));
          g.guessedCount++;
          const drawer = g.players.find(p => p.id === g.drawer);
          if (drawer) drawer.score += 50;
          this.announce(`${player.name} guessed the word!`, 'correct');
          await this.persist(); this.sync();
          const eligible = g.order.filter(id => id !== g.drawer && g.players.some(p => p.id === id && p.connected));
          if (eligible.length && eligible.every(id => g.players.find(p => p.id === id)?.guessed)) await this.reveal();
          return;
        }
      }
      // Never reveal the answer through the chat if the drawer or a winner types it.
      if (g.phase === 'drawing' && normalizeGuess(text) === normalizeGuess(g.answer)) {
        send(ws, { type: 'error', message: 'The secret word cannot be posted in chat.' }); return;
      }
      const message = { type: 'chat', player: player.name, text, time: Date.now() };
      g.messages.push(message); g.messages = g.messages.slice(-45);
      this.broadcast({ type: 'message', message }); await this.persist(); return;
    }
  }
  async nextTurn() {
    const g = this.game;
    if (g.turn >= g.order.length * g.settings.rounds) {
      g.drawer = null; g.answer = ''; g.options = [];
      await this.setPhase('ended');
      this.announce('Game finished! Play again?');
      return;
    }
    const candidates = g.order.filter(id => g.players.some(p => p.id === id && p.connected));
    if (candidates.length < 2) {
      g.drawer = null; g.answer = ''; g.options = []; g.order = [];
      await this.setPhase('lobby');
      this.announce('Waiting for more players to continue.');
      return;
    }
    // Skip disconnected players without getting stuck in the same round.
    while (g.turn < g.order.length * g.settings.rounds && !candidates.includes(g.order[g.turn % g.order.length])) g.turn++;
    if (g.turn >= g.order.length * g.settings.rounds) return this.nextTurn();
    g.round = Math.floor(g.turn / g.order.length) + 1;
    g.drawer = g.order[g.turn % g.order.length]; g.turn++;
    g.answer = ''; g.options = pickWords(); g.hintCount = 0; g.hintStage = 0; g.guessedCount = 0; g.strokes = []; this.pendingStrokes = 0;
    for (const p of g.players) p.guessed = false;
    await this.setPhase('choosing', 15);
    this.announce(`${g.players.find(p => p.id === g.drawer)?.name || 'Someone'} is choosing a word…`);
  }
  async beginDrawing(word) {
    if (this.game.phase !== 'choosing') return;
    this.game.answer = word; this.game.options = []; this.game.hintCount = 0; this.game.hintStage = 0;
    await this.setPhase('drawing', this.game.settings.seconds);
    this.announce('A new drawing has started!');
    await this.scheduleHint();
  }
  async scheduleHint() {
    const g = this.game;
    if (g.phase !== 'drawing') return;
    const period = g.settings.seconds * 1000;
    const next = g.hintStage === 0 ? g.endsAt - period * 0.55 : g.hintStage === 1 ? g.endsAt - period * 0.25 : g.endsAt;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.round(next)));
  }
  async reveal() {
    if (this.game.phase !== 'drawing' && this.game.phase !== 'choosing') return;
    this.game.lastWord = this.game.answer || this.game.options[0] || '???';
    this.game.answer = ''; this.game.options = [];
    await this.setPhase('reveal', 5);
    this.announce(`The word was ${this.game.lastWord}`, 'reveal');
  }
  async alarm() {
    const g = this.game;
    if (g.phase === 'choosing') { await this.beginDrawing(g.options[0]); return; }
    if (g.phase === 'drawing') {
      if (Date.now() >= g.endsAt - 150) { await this.reveal(); return; }
      const letters = g.answer.replace(/[^a-z0-9]/gi, '').length;
      g.hintCount = Math.min(Math.max(1, Math.floor(letters * (g.hintCount === 0 ? 0.22 : 0.43))), letters - 1);
      // Need a stage separate from hint count; short answers can reveal the same number of letters.
      g.hintStage = (g.hintStage || 0) + 1;
      if (g.hintStage >= 2) g.hintCount = Math.min(letters - 1, Math.max(g.hintCount, Math.floor(letters * 0.43)));
      await this.persist(); this.sync();
      if (g.hintStage >= 2) await this.ctx.storage.setAlarm(g.endsAt);
      else await this.scheduleHint();
      return;
    }
    if (g.phase === 'reveal') await this.nextTurn();
  }
  async webSocketClose(ws) { await this.leave(ws); }
  async webSocketError(ws) { await this.leave(ws); }
  async leave(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    const p = this.game.players.find(p => p.id === pid);
    if (!p) return;
    // A reconnect can have already replaced this socket; don't mark that player offline.
    if (this.ctx.getWebSockets().some(other => other !== ws && other.deserializeAttachment()?.pid === pid)) return;
    p.connected = false;
    this.announce(`${p.name} disconnected`);
    if (this.game.host === pid) this.game.host = this.game.players.find(live)?.id || null;
    if (this.game.drawer === pid && ['choosing','drawing'].includes(this.game.phase)) await this.reveal();
    await this.persist(); this.sync();
  }
}
