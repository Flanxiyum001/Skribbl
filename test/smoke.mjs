// End-to-end smoke test against the Render-compatible Node WebSocket server.
import assert from 'node:assert/strict';

const port = process.env.PORT || 8787;
const base = `http://127.0.0.1:${port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, description, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function startServerCheck() {
  await poll(async () => {
    try { const r = await fetch(`${base}/api/health`); return r.ok; }
    catch { return false; }
  }, 'Node local HTTP server', 30000);
}
async function join(code, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${code}/ws`);
  const received = [];
  ws.addEventListener('message', e => received.push(JSON.parse(e.data)));
  ws.addEventListener('error', e => { console.error('WebSocket error', name, e.message || 'unknown'); });
  await poll(() => ws.readyState === WebSocket.OPEN, `${name} socket`);
  ws.send(JSON.stringify({ type: 'join', name, token: crypto.randomUUID() }));
  const joined = await poll(() => received.find(m => m.type === 'joined'), `${name} join`);
  return {
    ws, id: joined.id, received,
    send: packet => ws.send(JSON.stringify(packet)),
    state: () => [...received].reverse().find(m => m.type === 'state'),
    waitState: (fn, why) => poll(() => {
      const s = [...received].reverse().find(m => m.type === 'state' && fn(m));
      return s;
    }, why),
    waitEvent: (type) => poll(() => received.find(m => m.type === type), type),
  };
}

await startServerCheck();
const created = await fetch(`${base}/api/rooms`, { method: 'POST' });
assert.equal(created.status, 201);
const { code } = await created.json();
assert.match(code, /^[A-Z2-9]{6}$/);
console.log('Created room:', code);
const alpha = await join(code, 'Alpha');
const beta = await join(code, 'Beta');
try {
  await alpha.waitState(s => s.players.filter(p => p.connected).length === 2, 'two player lobby');
  alpha.send({ type: 'start' });
  const choosing = await alpha.waitState(s => s.phase === 'choosing', 'choosing round');
  const drawer = choosing.drawer === alpha.id ? alpha : beta;
  const guesser = drawer === alpha ? beta : alpha;
  const artistState = await drawer.waitState(s => s.phase === 'choosing' && s.options.length === 3, 'artist word choices');
  const answer = artistState.options[0];
  const guesses = await guesser.waitState(s => s.phase === 'choosing', 'guesser chooses state');
  assert.deepEqual(guesses.options, [], 'guesser should not see secret words');
  drawer.send({ type: 'choose', word: answer });
  await drawer.waitState(s => s.phase === 'drawing', 'drawing phase');
  const hidden = await guesser.waitState(s => s.phase === 'drawing', 'guesser drawing phase');
  assert.equal(hidden.word, null, 'word is concealed from guesser');
  assert.ok(hidden.masked.includes('_'));
  drawer.send({ type: 'stroke', p: [.25,.25,.5,.5], color: '#000000', size: 5 });
  await guesser.waitEvent('stroke');
  guesser.send({ type: 'chat', text: answer.toUpperCase() });
  const revealed = await guesser.waitState(s => s.phase === 'reveal', 'correct guess and reveal');
  assert.equal(revealed.word, answer);
  assert.ok(revealed.players.find(p => p.id === guesser.id).score >= 100);
  assert.ok(!guesser.received.some(m => m.type === 'message' && m.message?.type === 'chat' && m.message.text === answer.toUpperCase()), 'correct guess must not leak in chat');
  console.log('PASS: room creation, two players, hidden words, drawing, validated guess, score and reveal');
} finally {
  alpha.ws.close(); beta.ws.close();
}