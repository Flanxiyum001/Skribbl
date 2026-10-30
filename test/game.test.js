import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../src/room.js';
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


test('sustained batched drawing never freezes after 50 messages, and late joiners resync', async () => {
  const ctx = fakeContext(), room = new GameRoom(ctx, {}); await ctx.ready;
  room.game.created = true;
  const a = new FakeSocket(), b = new FakeSocket(); ctx.sockets.push(a,b);
  const tokenA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const tokenB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  await room.webSocketMessage(a, JSON.stringify({type:'join',protocol:2,name:'A',token:tokenA}));
  await room.webSocketMessage(b, JSON.stringify({type:'join',protocol:2,name:'B',token:tokenB}));
  await room.webSocketMessage(a, JSON.stringify({type:'start'}));
  const drawer = room.game.drawer === latest(a,'joined').id ? a : b;
  const watcher = drawer === a ? b : a;
  await room.webSocketMessage(drawer, JSON.stringify({type:'choose',word:room.game.options[0]}));
  for (let i = 0; i < 160; i++) {
    await room.webSocketMessage(drawer, JSON.stringify({type:'strokes',color:'#000000',size:5,p:[.1,.1,i/160,.5]}));
  }
  assert.equal(room.game.strokes.length,160);
  assert.equal(watcher.messages.filter(x=>x.type==='strokes').length,160);
  const big = Array.from({length:48}, (_,i)=>[i/100,0,i/100,.7]).flat();
  await room.webSocketMessage(drawer, JSON.stringify({type:'strokes',color:'#f87171',size:8,p:big}));
  assert.equal(room.game.strokes.length,208);
  assert.equal(latest(watcher,'strokes').p.length,192);
  room.sync();
  assert.equal(Object.hasOwn(latest(watcher,'state'),'strokes'),false);
  const late=new FakeSocket();ctx.sockets.push(late);
  await room.webSocketMessage(late, JSON.stringify({type:'join',protocol:2,name:'Late',token:'cccccccc-cccc-4ccc-cccc-cccccccccccc'}));
  assert.equal(latest(late,'state').strokes.length,208);
  assert.equal(Object.hasOwn(latest(watcher,'state'),'strokes'),false);
});

test('drawing validates packets and clear resets canvas epoch', async () => {
  const ctx=fakeContext(),room=new GameRoom(ctx,{});await ctx.ready;
  room.game.created=true;
  const a=new FakeSocket(),b=new FakeSocket();ctx.sockets.push(a,b);
  await room.webSocketMessage(a,JSON.stringify({type:'join',protocol:2,name:'A',token:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'}));
  await room.webSocketMessage(b,JSON.stringify({type:'join',protocol:2,name:'B',token:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'}));
  await room.webSocketMessage(a,JSON.stringify({type:'start'}));
  const drawer=room.game.drawer===latest(a,'joined').id?a:b;
  const viewer=drawer===a?b:a;
  await room.webSocketMessage(drawer,JSON.stringify({type:'choose',word:room.game.options[0]}));
  const normal={type:'strokes',color:'#000000',size:5,p:[0,0,.5,.5]};
  await room.webSocketMessage(viewer,JSON.stringify(normal));
  await room.webSocketMessage(drawer,JSON.stringify({...normal,p:[0,0,2,1]}));
  await room.webSocketMessage(drawer,JSON.stringify({...normal,p:new Array(49*4).fill(.5)}));
  assert.equal(room.game.strokes.length,0);
  await room.webSocketMessage(drawer,JSON.stringify(normal));
  assert.equal(room.game.strokes.length,1);
  const epoch=room.game.canvasEpoch;
  await room.webSocketMessage(drawer,JSON.stringify({type:'clear'}));
  assert.equal(room.game.canvasEpoch,epoch+1);
  assert.equal(room.game.strokes.length,0);
  assert.equal(latest(viewer,'clear').canvasEpoch,epoch+1);
});


test('office privacy: correct guess hides server word and round reveal never leaks into chat', async () => {
  const ctx = fakeContext(), room = new GameRoom(ctx, {}); await ctx.ready;
  room.game.created = true;
  const sockets = [new FakeSocket(),new FakeSocket(),new FakeSocket()];
  ctx.sockets.push(...sockets);
  const names = ['Alpha','Beta','Gamma'];
  for (let i=0; i<sockets.length; i++) {
    const token = `${String(i+1).repeat(8)}-${String(i+1).repeat(4)}-4${String(i+1).repeat(3)}-a${String(i+1).repeat(3)}-${String(i+1).repeat(12)}`;
    await room.webSocketMessage(sockets[i], JSON.stringify({type:'join',protocol:2,name:names[i],token}));
  }
  await room.webSocketMessage(sockets[0],JSON.stringify({type:'start'}));
  const artist = sockets.find(ws=>latest(ws,'joined').id === room.game.drawer);
  const guesser = sockets.find(ws=>ws!==artist);
  const answer = room.game.options[0];
  await room.webSocketMessage(artist,JSON.stringify({type:'choose',word:answer}));
  assert.equal(latest(artist,'state').word, answer);
  assert.equal(latest(guesser,'state').word,null);
  await room.webSocketMessage(guesser,JSON.stringify({type:'chat',text:answer.toUpperCase()}));
  assert.equal(room.game.phase,'drawing','one correct guess must not finish a three-person round');
  const privateState=latest(guesser,'state');
  assert.equal(privateState.players.find(p=>p.id===latest(guesser,'joined').id).guessed,true);
  assert.equal(privateState.word,null,'a correct guess must not reveal the answer over the socket');
  assert.equal(privateState.masked,'••••••','a correct guesser does not get hints that reveal the word');
  assert.ok(!guesser.messages.some(m=>m.type==='message' && m.message?.text?.includes(answer)));
  await room.reveal();
  assert.equal(latest(guesser,'state').word,answer,'the ended round may reveal only when the user opts in');
  assert.ok(!room.game.messages.some(m=>m.kind==='reveal' && m.text.includes(answer)),'round-end chat must not publish answer');
});
