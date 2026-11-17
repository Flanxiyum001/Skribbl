import test from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../src/room.js';

class Socket {
  messages = [];
  attached = null;
  closed = false;
  send(data) { this.messages.push(JSON.parse(data)); }
  serializeAttachment(value) { this.attached = structuredClone(value); }
  deserializeAttachment() { return this.attached; }
  close(code) { this.closed = true; this.closeCode = code; }
}
function setup() {
  const sockets = [], store = new Map();
  const ctx = {
    sockets, ready: null,
    getWebSockets() { return sockets.filter(s => !s.closed); },
    blockConcurrencyWhile(fn) { ctx.ready = fn(); },
    storage: {
      async get(key) { return store.get(key); },
      async put(key, value) { store.set(key, structuredClone(value)); },
      async setAlarm() {},
      async deleteAlarm() {}
    }
  };
  const room = new GameRoom(ctx, {});
  return { room, ctx };
}
function latest(socket, type) { return socket.messages.findLast(m => m.type === type); }
async function join(room, ctx, index) {
  const socket = new Socket();
  const token = `${String(index).repeat(8)}-${String(index).repeat(4)}-4${String(index).repeat(3)}-a${String(index).repeat(3)}-${String(index).repeat(12)}`;
  ctx.sockets.push(socket);
  await room.webSocketMessage(socket, JSON.stringify({type:'join',protocol:2,name:`Player ${index}`,token}));
  return { socket, token, id: latest(socket,'joined').id };
}
const send = (room, socket, message) => room.webSocketMessage(socket, JSON.stringify(message));

test('reactions are one vote per non-artist, toggleable, synced, and reset each drawing', async () => {
  const {room,ctx} = setup(); await ctx.ready;
  const players = [];
  for (let i=1;i<=3;i++) players.push(await join(room,ctx,i));
  await send(room,players[0].socket,{type:'start'});
  const artist = players.find(p=>p.id === room.game.drawer);
  const others = players.filter(p=>p !== artist);
  await send(room,artist.socket,{type:'choose',word:room.game.options[0]});
  await send(room,artist.socket,{type:'react',value:'like'});
  await send(room,others[0].socket,{type:'react',value:'bogus'});
  assert.deepEqual(room.game.reactions,{like:[],dislike:[]},'artist and invalid reactions are ignored');
  await send(room,others[0].socket,{type:'react',value:'like'});
  await send(room,others[0].socket,{type:'react',value:'like'});
  assert.deepEqual(room.game.reactions,{like:[],dislike:[]},'repeating a reaction toggles it off');
  await send(room,others[0].socket,{type:'react',value:'like'});
  await send(room,others[0].socket,{type:'react',value:'dislike'});
  await send(room,others[1].socket,{type:'react',value:'like'});
  const state = latest(others[0].socket,'state');
  assert.deepEqual(state.reactions,{like:1,dislike:1,mine:'dislike'});
  assert.equal(latest(artist.socket,'state').reactions.mine,null);
  assert.equal(Object.hasOwn(state,'strokes'),false,'voting does not trigger a canvas snapshot');
  await room.reveal();
  await send(room,others[0].socket,{type:'react',value:'like'});
  assert.deepEqual(latest(others[0].socket,'state').reactions,{like:2,dislike:0,mine:'like'});
  await room.alarm();
  assert.deepEqual(room.game.reactions,{like:[],dislike:[]},'new artist gets a clean drawing vote');
});

test('kick needs distinct supermajority, switches off, removes host, and bans kicked session', async () => {
  const {room,ctx} = setup(); await ctx.ready;
  const players = [];
  for (let i=1;i<=4;i++) players.push(await join(room,ctx,i));
  const [host,b,c,d] = players;
  await send(room,b.socket,{type:'vote_kick',target:host.id});
  assert.equal(latest(d.socket,'state').kickVotes[host.id].required,2);
  assert.equal(latest(d.socket,'state').kickVotes[host.id].count,1);
  await send(room,b.socket,{type:'vote_kick',target:host.id});
  assert.equal(latest(d.socket,'state').kickVotes[host.id].count,0,'same player toggles ballot off');
  await send(room,b.socket,{type:'vote_kick',target:host.id});
  await send(room,host.socket,{type:'vote_kick',target:host.id});
  await send(room,c.socket,{type:'vote_kick',target:'invented'});
  assert.equal(room.game.players.length,4,'self-votes and unknown targets do nothing');
  await send(room,c.socket,{type:'vote_kick',target:host.id});
  assert.equal(host.socket.closed,true);
  assert.equal(host.socket.closeCode,4003);
  assert.equal(latest(host.socket,'kicked').type,'kicked');
  assert.equal(room.game.players.length,3);
  assert.equal(room.game.host,b.id,'next connected player becomes host');
  assert.equal(room.game.players.some(p=>p.id === host.id),false);
  assert.ok(room.game.kickedTokens.includes(host.token));
  const rejoin = new Socket(); ctx.sockets.push(rejoin);
  await send(room,rejoin,{type:'join',token:host.token,name:'Sneaky'});
  assert.equal(rejoin.closeCode,4003,'kicked session token cannot rejoin');
  assert.equal(latest(rejoin,'joined'),undefined);
  assert.equal(room.game.players.length,3);
});

test('kicking the current artist safely finishes the turn and advances to a valid player', async () => {
  const {room,ctx} = setup(); await ctx.ready;
  const players = [];
  for (let i=1;i<=3;i++) players.push(await join(room,ctx,i));
  await send(room,players[0].socket,{type:'start'});
  const artist = players.find(p=>p.id === room.game.drawer);
  const others = players.filter(p=>p !== artist);
  await send(room,artist.socket,{type:'choose',word:room.game.options[0]});
  await send(room,others[0].socket,{type:'vote_kick',target:artist.id});
  await send(room,others[1].socket,{type:'vote_kick',target:artist.id});
  assert.equal(room.game.phase,'reveal','current drawing ends when artist is kicked');
  assert.equal(artist.socket.closed,true);
  await room.alarm();
  assert.equal(room.game.phase,'choosing');
  assert.notEqual(room.game.drawer,artist.id);
  assert.ok(room.game.players.some(p=>p.id===room.game.drawer));
});

test('offline ballots are removed, and two connected players cannot kick anyone', async () => {
  const {room,ctx} = setup(); await ctx.ready;
  const players = [];
  for (let i=1;i<=3;i++) players.push(await join(room,ctx,i));
  const [target,b,c] = players;
  await send(room,b.socket,{type:'vote_kick',target:target.id});
  assert.equal(room.game.kickVotes[target.id].length,1);
  b.socket.close();
  await room.leave(b.socket);
  assert.equal(room.game.kickVotes[target.id],undefined);
  assert.equal(latest(c.socket,'state').canVoteKick,false);
  await send(room,c.socket,{type:'vote_kick',target:target.id});
  assert.equal(target.socket.closed,false);
});
