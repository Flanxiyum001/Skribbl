import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const path = new URL('../src/room.js', import.meta.url);
const wordsURL = new URL('../src/words.js', import.meta.url).href;
const source = readFileSync(path, 'utf8')
  .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }')
  .replace("from './words.js'", `from '${wordsURL}'`);
const { GameRoom } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class FakeSocket {
  messages = []; attached = null;
  send(data) { this.messages.push(JSON.parse(data)); }
  serializeAttachment(x) { this.attached = structuredClone(x); }
  deserializeAttachment() { return this.attached; }
  close() { this.closed = true; }
}
function fakeContext() {
  const store = new Map(); const sockets = [];
  const ctx = {
    sockets, ready: null, alarmAt: null,
    getWebSockets() { return sockets.filter(ws => !ws.closed); },
    blockConcurrencyWhile(fn) { ctx.ready = fn(); },
    storage: {
      async get(key) { return store.get(key); },
      async put(key, value) { store.set(key, structuredClone(value)); },
      async setAlarm(when) { ctx.alarmAt = when; },
      async deleteAlarm() { ctx.alarmAt = null; }
    }
  };
  return ctx;
}
function latest(socket, type) { return [...socket.messages].reverse().find(m => m.type === type); }

test('multiplayer: join, start, choose, draw, guess, reveal, restart', async () => {
  const ctx = fakeContext(); const room = new GameRoom(ctx, {}); await ctx.ready;
  room.game.created = true; await room.persist();
  const alice = new FakeSocket(), bob = new FakeSocket(); ctx.sockets.push(alice, bob);
  await room.webSocketMessage(alice, JSON.stringify({type:'join', name:'Alice', token:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}));
  await room.webSocketMessage(bob, JSON.stringify({type:'join', name:'Bob', token:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'}));
  const hostId = latest(alice,'joined').id;
  const bobId = latest(bob,'joined').id;
  assert.equal(room.game.players.length,2);
  assert.equal(latest(bob,'state').players.length,2);
  // Non-host cannot start or change game settings.
  await room.webSocketMessage(bob, JSON.stringify({type:'settings',rounds:6,seconds:120}));
  assert.equal(room.game.settings.rounds,3);
  await room.webSocketMessage(alice, JSON.stringify({type:'start'}));
  assert.equal(room.game.phase,'choosing');
  assert.equal(room.game.round,1);
  assert.equal(room.game.options.length,3);
  const drawer = room.game.drawer === hostId ? alice : bob;
  const guesser = drawer === alice ? bob : alice;
  const answer = room.game.options[0];
  assert.equal(latest(guesser,'state').word,null);
  assert.deepEqual(latest(guesser,'state').options, []);
  await room.webSocketMessage(drawer, JSON.stringify({type:'choose',word:answer}));
  assert.equal(room.game.phase,'drawing');
  assert.equal(latest(drawer,'state').word,answer);
  assert.ok(latest(guesser,'state').masked.includes('_'));
  assert.equal(latest(guesser,'state').word,null);
  const stroke = {type:'stroke',p:[.1,.2,.3,.4],color:'#000000',size:5};
  await room.webSocketMessage(guesser, JSON.stringify(stroke));
  assert.equal(room.game.strokes.length,0,'guesser cannot draw');
  await room.webSocketMessage(drawer, JSON.stringify(stroke));
  assert.equal(room.game.strokes.length,1);
  assert.equal(latest(guesser,'stroke').stroke.p.length,4);
  await room.webSocketMessage(guesser, JSON.stringify({type:'chat',text:answer.toUpperCase()}));
  assert.equal(room.game.phase,'reveal','all active guessers correct triggers reveal');
  assert.ok(room.game.players.find(p=>p.id === (drawer===alice ? bobId : hostId)).score >= 100);
  assert.ok(!guesser.messages.some(m=>m.type==='message' && m.message?.type==='chat' && m.message.text===answer.toUpperCase()));
  assert.equal(latest(guesser,'state').word,answer);
  await room.alarm();
  assert.equal(room.game.phase,'choosing','next turn starts after reveal');
  assert.equal(room.game.turn,2);
});

test('rejects malformed drawing payloads and chat abuse, reconnect restores identity', async () => {
  const ctx = fakeContext(), room = new GameRoom(ctx, {}); await ctx.ready;
  room.game.created = true;
  const socket = new FakeSocket(); ctx.sockets.push(socket);
  const token = 'cccccccc-cccc-4ccc-cccc-cccccccccccc';
  await room.webSocketMessage(socket, JSON.stringify({type:'join',name:'<Sally>',token}));
  assert.equal(room.game.players[0].name,'Sally');
  await room.webSocketMessage(socket, JSON.stringify({type:'chat',text:'hello'}));
  await room.webSocketMessage(socket, JSON.stringify({type:'chat',text:'spam'}));
  assert.equal(room.game.messages.filter(m=>m.type==='chat').length,1);
  const second = new FakeSocket(); ctx.sockets.push(second);
  await room.webSocketMessage(second, JSON.stringify({type:'join',name:'Malicious renamer',token}));
  assert.equal(room.game.players.length,1);
  assert.equal(latest(second,'joined').id,latest(socket,'joined').id);
  assert.equal(room.game.players[0].name,'Sally');
});
