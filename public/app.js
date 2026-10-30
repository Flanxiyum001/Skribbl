const $ = (id) => document.getElementById(id);
const COLORS = ['#000000','#787c91','#ffffff','#f87171','#fb923c','#fbbf24','#a3e635','#34d399','#2dd4bf','#38bdf8','#818cf8','#c084fc','#f472b6','#b45309'];
const canvas = $('draw-canvas');
const ctx = canvas.getContext('2d');
const app = {
  code: null, socket: null, state: null, me: null, token: null, drawing: false,
  color: COLORS[0], lastPoint: null, drawPointerId: null, pendingStrokes: [], pendingStyle: null, flushTimer: null, canvasEpoch: null, stopped: false, attempts: 0,
  chatFingerprint: '', toastTimer: null, privacyTurn: null, hideArtistWord: false, hideRevealWord: true, activeGesture: null
};
$('nickname').value = localStorage.getItem('dd:nickname') || '';
const queryRoom = new URLSearchParams(window.location.search).get('room');
if (queryRoom && /^[A-Z2-9]{6}$/i.test(queryRoom)) $('room-code').value = queryRoom.toUpperCase();

function toast(message) {
  const box = $('toast'); box.textContent = message; box.classList.add('visible');
  clearTimeout(app.toastTimer); app.toastTimer = setTimeout(() => box.classList.remove('visible'), 3200);
}
function showError(error) {
  $('landing-error').textContent = error;
  $('landing-error').hidden = false;
  toast(error);
}
function nickname() {
  const name = $('nickname').value.trim().replace(/[<>\x00-\x1f]/g, '').slice(0, 18) || 'Guest';
  localStorage.setItem('dd:nickname', name);
  return name;
}
function setBusy(busy) {
  $('create-room').disabled = busy;
  $('join-room').disabled = busy;
}
function send(message) {
  if (app.socket?.readyState === WebSocket.OPEN && app.socket.bufferedAmount < 256 * 1024) app.socket.send(JSON.stringify(message));
}
async function createRoom() {
  setBusy(true); $('landing-error').hidden = true;
  try {
    const response = await fetch('/api/rooms', { method: 'POST' });
    if (!response.ok) throw new Error('Could not create a room. Is the game server running?');
    const { code } = await response.json();
    enterRoom(code);
  } catch (error) { showError(error.message); }
  finally { setBusy(false); }
}
function joinRoom() {
  $('landing-error').hidden = true;
  const code = $('room-code').value.toUpperCase().replace(/\s/g, '');
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return showError('Enter the 6-character code from your friend.');
  enterRoom(code);
}
function enterRoom(code) {
  app.stopped = false; app.code = code; app.attempts = 0; app.state = null; app.me = null; app.canvasEpoch = null; app.privacyTurn = null; app.hideArtistWord = false; app.hideRevealWord = true; discardPending();
  app.token = sessionStorage.getItem('dd:token:' + code) || crypto.randomUUID();
  sessionStorage.setItem('dd:token:' + code, app.token);
  $('landing').hidden = true; $('game-screen').hidden = false;
  $('room-display').textContent = code;
  window.history.replaceState(null, '', `${location.pathname}?room=${code}`);
  document.title = `Room ${code} · DoodleDash`;
  renderCanvas([]);
  connect();
}
function connect() {
  if (app.stopped || !app.code) return;
  if (app.socket) { app.socket.onclose = null; app.socket.close(); }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}/api/rooms/${app.code}/ws`);
  app.socket = ws;
  ws.onopen = () => { app.attempts = 0; send({ type: 'join', protocol: 2, name: nickname(), token: app.token }); };
  ws.onmessage = (event) => {
    let packet; try { packet = JSON.parse(event.data); } catch { return; }
    if (packet.type === 'joined') {
      app.me = packet.id; app.token = packet.token;
      sessionStorage.setItem('dd:token:' + app.code, app.token);
    } else if (packet.type === 'state') {
      app.state = packet; render();
    } else if (packet.type === 'stroke') {
      if (app.state?.drawer !== app.me) stroke(packet.stroke);
    } else if (packet.type === 'strokes') {
      if (app.state?.drawer !== app.me) strokeBatch(packet);
    } else if (packet.type === 'clear') {
      discardPending(); app.canvasEpoch = packet.canvasEpoch; renderCanvas([]);
    } else if (packet.type === 'message') {
      if (app.state) {
        app.state.messages.push(packet.message);
        app.state.messages = app.state.messages.slice(-45);
        renderMessages();
      }
    } else if (packet.type === 'error') {
      toast(packet.message);
    }
  };
  ws.onclose = (ev) => {
    discardPending();
    if (app.stopped || app.socket !== ws) return;
    if (ev.code === 1008) return leaveRoom('Room is full or unavailable.');
    if (++app.attempts > 6) return leaveRoom('Connection failed. Please try joining again.');
    toast('Connection lost. Reconnecting…');
    setTimeout(connect, Math.min(5000, 700 * app.attempts));
  };
  ws.onerror = () => { /* onclose performs retries and reports failures */ };
}
function leaveRoom(message) {
  app.stopped = true; discardPending();
  if (app.socket) { app.socket.onclose = null; app.socket.close(); }
  app.socket = null; app.state = null; app.code = null; app.me = null;
  $('landing').hidden = false; $('game-screen').hidden = true;
  window.history.replaceState(null, '', location.pathname);
  document.title = 'DoodleDash — Draw. Guess. Repeat.';
  if (message) showError(message);
}
function render() {
  const s = app.state;
  if (!s) return;
  // Privacy only resets on a new turn, not on a chat update, hint, or reconnect.
  const turnKey = `${s.round}:${s.turn}:${s.drawer}`;
  if (app.privacyTurn !== turnKey) {
    app.privacyTurn = turnKey;
    app.hideArtistWord = false;
    app.hideRevealWord = true;
  }
  const active = s.players.filter(p => p.connected);
  const myPlayer = s.players.find(p => p.id === app.me);
  const isHost = s.host === app.me;
  const amDrawing = s.drawer === app.me && s.phase === 'drawing';
  const drawer = s.players.find(p => p.id === s.drawer);
  $('player-count').textContent = `${active.length} / 12`;
  $('round-display').textContent = s.round ? `${s.round} / ${s.settings.rounds}` : '—';
  $('drawer-display').textContent = s.phase === 'lobby' ? 'Waiting for players' : (drawer ? `${drawer.name} drawing` : 'Game finished');
  // Never display the answer after a successful guess; the server also withholds it.
  const guessedCorrectly = s.phase === 'drawing' && !amDrawing && !!myPlayer?.guessed;
  const artistCanHide = amDrawing && !!s.word;
  const concealed = (artistCanHide && app.hideArtistWord) || guessedCorrectly ||
    (s.phase === 'reveal' && app.hideRevealWord);
  $('word-display').textContent = s.phase === 'lobby' ? 'Waiting for the game…'
    : s.phase === 'choosing' ? 'Choosing a word…'
    : s.phase === 'drawing' ? (guessedCorrectly ? '••••••  ✓ You got it!' : artistCanHide && app.hideArtistWord ? '••••••' : (s.word || s.masked))
    : s.phase === 'reveal' ? (app.hideRevealWord ? '••••••' : (s.word || '???'))
    : 'Game complete!';
  $('word-display').classList.toggle('is-concealed', concealed);
  const artistToggle = $('word-privacy-toggle');
  artistToggle.hidden = !artistCanHide;
  artistToggle.textContent = app.hideArtistWord ? '👁 Show word' : '🙈 Hide word';
  artistToggle.setAttribute('aria-pressed', String(app.hideArtistWord));
  const revealToggle = $('reveal-privacy-toggle');
  revealToggle.hidden = s.phase !== 'reveal';
  revealToggle.textContent = app.hideRevealWord ? '👁 Show answer' : '🙈 Hide answer';
  revealToggle.setAttribute('aria-pressed', String(!app.hideRevealWord));
  $('canvas-overlay').hidden = s.phase !== 'lobby';
  $('choose-overlay').hidden = s.phase !== 'choosing';
  $('reveal-overlay').hidden = s.phase !== 'reveal';
  $('end-overlay').hidden = s.phase !== 'ended';
  $('drawing-tools').hidden = !amDrawing;
  $('spectator-tip').hidden = amDrawing;
  $('draw-canvas').classList.toggle('can-draw', amDrawing);
  $('lobby-settings').hidden = !isHost;
  $('start-game').hidden = !isHost;
  $('start-game').disabled = active.length < 2;
  $('play-again').hidden = !isHost;
  $('rounds-select').value = String(s.settings.rounds);
  $('seconds-select').value = String(s.settings.seconds);
  $('choose-title').textContent = s.drawer === app.me ? 'Choose what to draw' : `${drawer?.name || 'Someone'} is choosing…`;
  $('choose-subtitle').textContent = s.drawer === app.me ? 'Pick a word before the timer runs out.' : 'Get ready to guess!';
  const choices = $('word-options'); choices.replaceChildren();
  if (s.drawer === app.me) for (const word of s.options) {
    const b = document.createElement('button'); b.textContent = word; b.type = 'button';
    b.addEventListener('click', () => send({ type: 'choose', word }));
    choices.appendChild(b);
  }
  $('reveal-word').textContent = app.hideRevealWord ? 'Answer hidden from nearby screens.' : `The word was “${s.word || '???'}”`;
  const winner = [...s.players].sort((a,b) => b.score - a.score)[0];
  $('winner-text').textContent = winner ? `🥇 ${winner.name} wins with ${winner.score} points!` : 'Thanks for playing!';
  $('chat-input').placeholder = myPlayer?.guessed ? 'You guessed it! Chat away…' : (s.phase === 'drawing' ? 'Type your guess…' : 'Say something…');
  // Only snapshots and a new canvas epoch require a full repaint.
  if (Array.isArray(s.strokes)) {
    discardPending(); renderCanvas(s.strokes); app.canvasEpoch = s.canvasEpoch;
  } else if (app.canvasEpoch !== s.canvasEpoch) {
    discardPending(); renderCanvas([]); app.canvasEpoch = s.canvasEpoch;
  }
  renderPlayers(); renderMessages(); updateClock();
}
function renderPlayers() {
  const s = app.state, list = $('player-list'); list.replaceChildren();
  [...s.players].sort((a,b) => b.score - a.score).forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'player' + (!p.connected ? ' offline' : '') + (p.id === app.me ? ' is-me' : '');
    const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = `#${i+1}`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = ['✿','✦','☻','⚡','♠','✎','★'][p.name.length % 7];
    const details = document.createElement('div'); details.style.minWidth = '0';
    const name = document.createElement('span'); name.className = 'player-name'; name.textContent = p.name + (p.id === app.me ? ' (you)' : '');
    const score = document.createElement('span'); score.className = 'player-score'; score.textContent = `${p.score} pts` + (p.spectator ? ' · spectator' : '');
    details.append(name, score);
    const tag = document.createElement('span'); tag.className = 'player-tag'; tag.textContent = p.id === s.drawer ? '✏' : p.guessed ? '✓' : p.id === s.host ? '♛' : '';
    row.append(rank, avatar, details, tag); list.appendChild(row);
  });
}
function renderMessages() {
  const messages = app.state?.messages || [];
  const signature = messages.map(m => `${m.time}:${m.text}`).join('|');
  if (signature === app.chatFingerprint) return;
  app.chatFingerprint = signature;
  const feed = $('chat-feed'); feed.replaceChildren();
  if (!messages.length) {
    const placeholder = document.createElement('div'); placeholder.className = 'chat-message system'; placeholder.textContent = 'Room chat is ready. Say hi! 👋'; feed.appendChild(placeholder);
  }
  messages.forEach(m => {
    const row = document.createElement('div'); row.className = 'chat-message' + (m.type === 'system' ? ' system ' + (m.kind || '') : '');
    if (m.type === 'chat') {
      const name = document.createElement('b'); name.textContent = `${m.player}: `;
      row.append(name, document.createTextNode(m.text));
    } else row.textContent = m.text;
    feed.appendChild(row);
  });
  feed.scrollTop = feed.scrollHeight;
}
function updateClock() {
  const s = app.state;
  if (!s || !s.endsAt) { $('timer-display').textContent = '--'; return; }
  const remaining = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));
  $('timer-display').textContent = String(remaining).padStart(2,'0');
}
function stroke(segment) {
  if (!segment || !Array.isArray(segment.p) || segment.p.length !== 4) return;
  const [x1,y1,x2,y2] = segment.p;
  ctx.beginPath();
  ctx.strokeStyle = segment.color;
  ctx.lineWidth = segment.size;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.moveTo(x1 * canvas.width, y1 * canvas.height);
  ctx.lineTo(x2 * canvas.width, y2 * canvas.height);
  ctx.stroke();
}
function strokeBatch(packet) {
  if (!Array.isArray(packet.p) || packet.p.length % 4 !== 0) return;
  for (let i = 0; i < packet.p.length; i += 4) {
    stroke({ p: packet.p.slice(i, i + 4), color: packet.color, size: packet.size });
  }
}
function renderCanvas(segments) {
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const segment of segments || []) stroke(segment);
}
function point(ev, rect) {
  const clamp = n => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
  return [clamp((ev.clientX - rect.left) / rect.width), clamp((ev.clientY - rect.top) / rect.height)];
}
function discardPending() {
  if (app.flushTimer) clearTimeout(app.flushTimer);
  app.flushTimer = null; app.pendingStrokes = []; app.pendingStyle = null;
  app.drawing = false; app.drawPointerId = null; app.lastPoint = null; app.activeGesture = null;
}
function flushStrokes() {
  if (app.flushTimer) clearTimeout(app.flushTimer);
  app.flushTimer = null;
  if (!app.pendingStrokes.length) return;
  if (!app.socket || app.socket.readyState !== WebSocket.OPEN) return discardPending();
  // Compact packets are capped below the server's 3 KiB message limit.
  while (app.pendingStrokes.length && app.socket.bufferedAmount < 128 * 1024) {
    const p = app.pendingStrokes.splice(0, 48).flat();
    send({ type: 'strokes', p, color: app.pendingStyle.color, size: app.pendingStyle.size, gesture: app.pendingStyle.gesture });
  }
  if (app.pendingStrokes.length && app.pendingStrokes.length > 500) {
    app.socket.close(1013, 'Drawing connection overloaded');
    return discardPending();
  }
  if (app.pendingStrokes.length) app.flushTimer = setTimeout(flushStrokes, 33);
  else app.pendingStyle = null;
}
function queueStroke(a, b, color, size, gesture = app.activeGesture) {
  if (app.pendingStyle && (app.pendingStyle.color !== color || app.pendingStyle.size !== size || app.pendingStyle.gesture !== gesture)) {
    flushStrokes();
    if (app.pendingStrokes.length) {
      app.socket?.close(1013, 'Slow drawing connection');
      return discardPending();
    }
  }
  app.pendingStyle = { color, size, gesture };
  app.pendingStrokes.push([...a, ...b]);
  if (!app.flushTimer) app.flushTimer = setTimeout(flushStrokes, 20);
}
function drawEvents(ev) {
  if (!app.drawing || app.drawPointerId !== ev.pointerId ||
      app.state?.drawer !== app.me || app.state?.phase !== 'drawing') return;
  const rect = canvas.getBoundingClientRect();
  const samples = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
  const events = samples.length ? samples : [ev];
  for (const sample of events) {
    const next = point(sample, rect), last = app.lastPoint || next;
    // Preserve smooth curves while dropping redundant subpixel samples.
    const distance = Math.hypot((next[0] - last[0]) * canvas.width, (next[1] - last[1]) * canvas.height);
    if (distance < 1.2 && next !== last) continue;
    const color = app.color, size = +$('brush-size').value;
    stroke({ p: [...last, ...next], color, size });
    queueStroke(last, next, color, size);
    app.lastPoint = next;
  }
}
function finishDraw(ev) {
  if (!app.drawing || app.drawPointerId !== ev.pointerId) return;
  const next = point(ev, canvas.getBoundingClientRect());
  const last = app.lastPoint || next;
  const color = app.color, size = +$('brush-size').value;
  stroke({ p: [...last, ...next], color, size });
  queueStroke(last, next, color, size);
  flushStrokes();
  app.drawing = false; app.lastPoint = null; app.drawPointerId = null; app.activeGesture = null;
  if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
}
function installCanvas() {
  canvas.addEventListener('pointerdown', ev => {
    if (app.state?.drawer !== app.me || app.state?.phase !== 'drawing' || app.drawing) return;
    ev.preventDefault(); app.drawing = true; app.drawPointerId = ev.pointerId; app.activeGesture = crypto.randomUUID();
    canvas.setPointerCapture(ev.pointerId);
    app.lastPoint = point(ev, canvas.getBoundingClientRect());
    const color = app.color, size = +$('brush-size').value;
    // Dots must work without any pointermove event.
    stroke({ p: [...app.lastPoint, ...app.lastPoint], color, size });
    queueStroke(app.lastPoint, app.lastPoint, color, size);
  });
  canvas.addEventListener('pointermove', ev => {
    if (!app.drawing) return;
    ev.preventDefault(); drawEvents(ev);
  });
  canvas.addEventListener('pointerup', finishDraw);
  canvas.addEventListener('pointercancel', ev => {
    if (app.drawPointerId !== ev.pointerId) return;
    flushStrokes(); app.drawing = false; app.lastPoint = null; app.drawPointerId = null; app.activeGesture = null;
  });
  canvas.addEventListener('lostpointercapture', ev => {
    if (app.drawPointerId !== ev.pointerId) return;
    flushStrokes(); app.drawing = false; app.lastPoint = null; app.drawPointerId = null; app.activeGesture = null;
  });
}
function editCanvas(action) {
  if (!['undo','redo'].includes(action) || app.state?.drawer !== app.me || app.state?.phase !== 'drawing') return;
  if (app.drawing) { toast('Lift your pen before editing.'); return; }
  // Flush pending ink first: WebSocket preserves send order.
  flushStrokes();
  if (app.pendingStrokes.length) { toast('Syncing drawing; try again.'); return; }
  send({ type: action });
}
function installPalette() {
  for (const color of COLORS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'color-swatch' + (color === app.color ? ' selected' : '');
    b.style.backgroundColor = color; b.title = color; b.setAttribute('aria-label', `Color ${color}`);
    b.addEventListener('click', () => {
      app.color = color;
      document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
      b.classList.add('selected'); $('eraser-tool').classList.remove('selected');
    });
    $('color-palette').appendChild(b);
  }
}
async function copyInvite() {
  if (!app.code) return;
  const link = new URL(location.href); link.searchParams.set('room', app.code);
  try { await navigator.clipboard.writeText(link.toString()); toast('Invite link copied! Share it with your crew. ✨'); }
  catch { window.prompt('Copy this invite link:', link.toString()); }
}
$('create-room').addEventListener('click', createRoom);
$('join-room').addEventListener('click', joinRoom);
$('room-code').addEventListener('keydown', ev => { if (ev.key === 'Enter') joinRoom(); });
$('nickname').addEventListener('keydown', ev => { if (ev.key === 'Enter') createRoom(); });
$('word-privacy-toggle').addEventListener('click', () => {
  if (app.state?.phase !== 'drawing' || app.state.drawer !== app.me) return;
  app.hideArtistWord = !app.hideArtistWord;
  render();
});
$('reveal-privacy-toggle').addEventListener('click', () => {
  if (app.state?.phase !== 'reveal') return;
  app.hideRevealWord = !app.hideRevealWord;
  render();
});
$('copy-link').addEventListener('click', copyInvite);
$('invite-game').addEventListener('click', copyInvite);
$('leave-room').addEventListener('click', () => leaveRoom());
$('start-game').addEventListener('click', () => send({ type: 'start' }));
$('play-again').addEventListener('click', () => send({ type: 'start' }));
$('rounds-select').addEventListener('change', () => send({ type: 'settings', rounds: +$('rounds-select').value, seconds: +$('seconds-select').value }));
$('seconds-select').addEventListener('change', () => send({ type: 'settings', rounds: +$('rounds-select').value, seconds: +$('seconds-select').value }));
$('undo-tool').addEventListener('click', () => editCanvas('undo'));
$('redo-tool').addEventListener('click', () => editCanvas('redo'));
document.addEventListener('keydown', ev => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
  const key = ev.key.toLowerCase();
  if (key === 'z') { ev.preventDefault(); editCanvas(ev.shiftKey ? 'redo' : 'undo'); }
  else if (key === 'y') { ev.preventDefault(); editCanvas('redo'); }
});
$('clear-tool').addEventListener('click', () => { if (confirm('Clear the whole canvas?')) { flushStrokes(); send({ type: 'clear' }); } });
$('eraser-tool').addEventListener('click', () => {
  app.color = '#ffffff';
  document.querySelectorAll('.color-swatch').forEach(el => el.classList.remove('selected'));
  $('eraser-tool').classList.add('selected');
});
$('chat-form').addEventListener('submit', ev => {
  ev.preventDefault(); const message = $('chat-input').value.trim(); if (!message) return;
  send({ type: 'chat', text: message }); $('chat-input').value = '';
});
window.addEventListener('pagehide', () => { app.stopped = true; app.socket?.close(); });
installCanvas(); installPalette(); renderCanvas([]); setInterval(updateClock, 250);
