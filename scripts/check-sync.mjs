// Run after npm run build: node scripts/check-sync.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { attachRealtime } from '../backend/dist/realtime.js';
import { createRoom, createFile, deleteRoom, getRoomDoc } from '../backend/dist/rooms.js';
const requireBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const requireFrontend = createRequire(new URL('../frontend/package.json', import.meta.url));
const Y = requireFrontend('yjs');
const { WebSocket } = requireBackend('ws');
const encoding = requireBackend('lib0/encoding');
const awarenessProtocol = requireFrontend('y-protocols/awareness');
const { WebsocketProvider } = requireFrontend('y-websocket');
const server = createServer();
attachRealtime(server);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `ws://127.0.0.1:${server.address().port}`;
const room = createRoom();
const providers = [], sockets = [];
async function until(check, message) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error(message);
}
async function join(id) {
  const ws = new WebSocket(base + '/ws');
  sockets.push(ws);
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'joinRoom', roomId: room.roomId, clientId: id, name: id }));
  await until(() => messages.some(m => m.type === 'roomState'), 'join timed out');
  return { ws, messages };
}
async function editor() {
  const doc = new Y.Doc();
  // No resyncInterval: verify server compatibility with existing y-websocket clients too.
  const provider = new WebsocketProvider(base + '/yjs', room.roomId, doc, { WebSocketPolyfill: WebSocket, disableBc: true });
  providers.push(provider);
  provider.awareness.setLocalStateField('user', { name: 'test' });
  await until(() => provider.synced, 'Yjs initial sync timed out');
  return provider;
}
try {
  const imported = createFile(room, 'windows.txt', 'one\r\ntwo\rthree');
  assert.equal(getRoomDoc(room.roomId).getText(`file:${imported.id}`).toString(), 'one\ntwo\nthree');
  console.log('PASS: CRLF and CR imports normalize to LF');

  const old = await join('same');
  const other = await join('other');
  const replacement = await join('same');
  await until(() => old.ws.readyState === WebSocket.CLOSED, 'old connection remained open');
  other.ws.send(JSON.stringify({ type: 'renameFile', roomId: room.roomId, fileId: imported.id, name: 'renamed.txt' }));
  await until(() => replacement.messages.some(m => m.type === 'filesUpdated'), 'replacement lost broadcasts');
  assert.equal(room.clients.size, 2);
  console.log('PASS: replacement socket retains membership and file events');

  const a = await editor(), b = await editor();
  const key = `file:${room.files[0].id}`;
  const value = p => p.doc.getText(key).toString();
  a.doc.getText(key).insert(0, '# A\n');
  b.doc.getText(key).insert(0, '# B\n');
  await until(() => value(a) === value(b) && value(a).includes('# A') && value(a).includes('# B'), 'concurrent edits did not converge');
  b.disconnect();
  a.doc.getText(key).insert(0, '# online\n');
  b.doc.getText(key).insert(0, '# queued\n');
  b.connect();
  await until(() => b.synced && value(a) === value(b) && value(a).includes('# queued') && value(a).includes('# online'), 'reconnect lost edits');
  assert.equal(value(a), getRoomDoc(room.roomId).getText(key).toString());
  console.log('PASS: concurrent and queued edits converge with server after reconnect');

  // Relay A's existing awareness through a fresh connection, then leave it.
  const relay = await editor();
  await until(() => relay.awareness.getStates().has(a.doc.clientID), 'missing A awareness');
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(a.awareness, [a.doc.clientID]));
  relay.ws.send(encoding.toUint8Array(encoder));
  await delay(50);
  relay.disconnect();
  await delay(100);
  const c = await editor();
  await until(() => c.awareness.getStates().has(a.doc.clientID), 'leaving relay erased another participant');
  c.disconnect();
  b.disconnect();
  console.log('PASS: disconnecting awareness relay preserves other participants');

  const bad = new WebSocket(base + '/yjs/' + room.roomId);
  sockets.push(bad);
  await once(bad, 'open');
  const closed = once(bad, 'close');
  bad.send(Buffer.from([0x80]));
  assert.equal((await closed)[0], 1003);
  a.doc.getText(key).insert(0, '# still alive\n');
  await until(() => getRoomDoc(room.roomId).getText(key).toString().includes('# still alive'), 'malformed message killed room');
  console.log('PASS: malformed Yjs packet closes only its connection');
  const invalidUrl = new WebSocket(base + '/yjs/%ZZ');
  sockets.push(invalidUrl);
  assert.equal((await once(invalidUrl, 'close'))[0], 1008);
  console.log('PASS: malformed room URL does not crash server');

  const socket = a.ws;
  // Longer than y-websocket's 30s watchdog. WebSocket ping/pong alone is insufficient.
  await delay(36000);
  assert.equal(a.ws, socket, 'idle provider needlessly reconnected');
  assert.equal(a.synced, true);
  console.log('PASS: lone idle client stays connected beyond watchdog timeout');
} finally {
  for (const provider of providers) { provider.destroy(); provider.doc.destroy(); }
  for (const socket of sockets) socket.terminate();
  deleteRoom(room.roomId);
  await new Promise(resolve => server.close(resolve));
}
