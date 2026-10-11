import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness, removeAwarenessStates, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  addUser,
  createFile,
  deleteFile,
  getRoom,
  getRoomDoc,
  nextColor,
  removeUser,
  renameFile,
  selectFile,
  serializeFiles,
  serializeRoom,
  setRoomDeletionHandler
} from './rooms.js';
import type { ClientMessage, Room } from './types.js';
import { runPythonFile } from './runner.js';

const messageSync = 0;
const messageAwareness = 1;
const activeRuns = new Map<string, AbortController>();

type YRoom = {
  doc: Y.Doc;
  awareness: Awareness;
  conns: Map<WebSocket, Set<number>>;
};

const yRooms = new Map<string, YRoom>();

setRoomDeletionHandler((roomId) => {
  const controller = activeRuns.get(roomId);
  controller?.abort();
  activeRuns.delete(roomId);

  const yRoom = yRooms.get(roomId);
  if (!yRoom) return;
  for (const conn of yRoom.conns.keys()) {
    conn.close();
  }
  yRoom.conns.clear();
  yRoom.awareness.destroy();
  yRooms.delete(roomId);
});

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function broadcast(room: Room, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const ws of room.clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

export function attachRealtime(server: Server) {
  const apiWss = new WebSocketServer({ noServer: true });
  const yWss = new WebSocketServer({ noServer: true });

  const alive = new Set<WebSocket>();
  for (const wss of [apiWss, yWss]) {
    wss.on('connection', (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
      ws.on('close', () => alive.delete(ws));
      ws.on('error', () => ws.terminate());
    });
  }
  const heartbeat = setInterval(() => {
    for (const wss of [apiWss, yWss]) {
      for (const ws of wss.clients) {
        if (!alive.delete(ws)) ws.terminate();
        else if (ws.readyState === WebSocket.OPEN) ws.ping();
      }
    }
  }, 15000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws') {
      apiWss.handleUpgrade(request, socket, head, (ws) => apiWss.emit('connection', ws, request));
      return;
    }
    if (url.pathname.startsWith('/yjs/')) {
      yWss.handleUpgrade(request, socket, head, (ws) => yWss.emit('connection', ws, request));
      return;
    }
    socket.destroy();
  });

  apiWss.on('connection', (ws) => {
    let joinedRoomId: string | null = null;
    let joinedClientId: string | null = null;

    ws.on('message', async (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as ClientMessage;
        const room = getRoom(message.roomId);
        if (!room) {
          send(ws, { type: 'error', message: 'Комната не найдена' });
          return;
        }

        if (message.type === 'joinRoom') {
          const name = message.name.trim();
          if (!name) throw new Error('Имя пользователя не может быть пустым');
          if (joinedRoomId && (joinedRoomId !== room.roomId || joinedClientId !== message.clientId)) {
            throw new Error('Соединение уже присоединено к комнате');
          }
          joinedRoomId = room.roomId;
          joinedClientId = message.clientId;
          const previous = room.clients.get(message.clientId);
          room.clients.set(message.clientId, ws);
          if (previous && previous !== ws) previous.close();
          addUser(room, {
            clientId: message.clientId,
            name,
            color: message.color || nextColor(room.users.length)
          });
          send(ws, { type: 'roomState', room: serializeRoom(room) });
          broadcast(room, { type: 'usersUpdated', users: room.users });
          return;
        }

        if (joinedRoomId !== room.roomId || !joinedClientId || room.clients.get(joinedClientId) !== ws) {
          throw new Error('Сначала присоединитесь к комнате');
        }

        if (message.type === 'leaveRoom') {
          removeUser(room, joinedClientId);
          broadcast(room, { type: 'usersUpdated', users: room.users });
          return;
        }

        if (message.type === 'createFile') {
          createFile(room, message.name, typeof message.content === 'string' ? message.content : '');
          broadcast(room, { type: 'filesUpdated', files: serializeFiles(room) });
          return;
        }

        if (message.type === 'renameFile') {
          renameFile(room, message.fileId, message.name);
          broadcast(room, { type: 'filesUpdated', files: serializeFiles(room) });
          return;
        }

        if (message.type === 'deleteFile') {
          deleteFile(room, message.fileId);
          broadcast(room, { type: 'filesUpdated', files: serializeFiles(room) });
          broadcast(room, { type: 'activeFileUpdated', activeFileId: room.activeFileId });
          return;
        }

        if (message.type === 'selectFile') {
          selectFile(room, message.fileId);
          broadcast(room, { type: 'activeFileUpdated', activeFileId: room.activeFileId });
          return;
        }

        if (message.type === 'runCode') {
          await runAndBroadcast(room, message.fileId, typeof message.content === 'string' ? message.content : undefined);
          return;
        }

        if (message.type === 'stopCode') {
          const controller = activeRuns.get(room.roomId);
          if (!controller) {
            send(ws, { type: 'error', message: 'Код сейчас не выполняется' });
            return;
          }
          controller.abort();
        }
      } catch (error) {
        send(ws, { type: 'error', message: error instanceof Error ? error.message : 'Неизвестная ошибка' });
      }
    });

    ws.on('close', () => {
      if (!joinedRoomId || !joinedClientId) return;
      const room = getRoom(joinedRoomId);
      if (!room || room.clients.get(joinedClientId) !== ws) return;
      removeUser(room, joinedClientId);
      broadcast(room, { type: 'usersUpdated', users: room.users });
    });
  });

  yWss.on('connection', (ws, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const roomId = decodeURIComponent(url.pathname.replace('/yjs/', ''));
    setupYjsConnection(ws, roomId);
  });
}

export async function runAndBroadcast(room: Room, fileId: string, contentOverride?: string) {
  if (activeRuns.has(room.roomId)) throw new Error('Код уже выполняется');

  const file = room.files.find((item) => item.id === fileId);
  if (!file) throw new Error('Файл не найден');
  if (file.language !== 'python') throw new Error('Можно запускать только Python-файлы');

  room.lastRun = { status: 'running', stdout: '', stderr: '', exitCode: null };
  broadcast(room, { type: 'runStarted', result: room.lastRun });

  const doc = getRoomDoc(room.roomId);
  const files = room.files.map((item) => ({
    name: item.name,
    content: item.id === fileId && contentOverride !== undefined ? contentOverride : doc.getText(`file:${item.id}`).toString()
  }));
  const controller = new AbortController();
  activeRuns.set(room.roomId, controller);

  try {
    const result = await runPythonFile(file.name, files, { signal: controller.signal });
    room.lastRun = result;
    broadcast(room, { type: 'runFinished', result });
    return result;
  } finally {
    if (activeRuns.get(room.roomId) === controller) activeRuns.delete(room.roomId);
  }
}

function getYRoom(roomId: string): YRoom {
  let yRoom = yRooms.get(roomId);
  if (!yRoom) {
    const doc = getRoomDoc(roomId);
    yRoom = {
      doc,
      awareness: new Awareness(doc),
      conns: new Map()
    };
    yRoom.awareness.setLocalState(null);
    yRoom.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: WebSocket | null) => {
      const changedClients = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(yRoom!.awareness, changedClients));
      const buff = encoding.toUint8Array(encoder);
      for (const conn of yRoom!.conns.keys()) {
        if (conn !== origin && conn.readyState === WebSocket.OPEN) conn.send(buff);
      }
    });
    doc.on('update', (update: Uint8Array, origin: WebSocket | null) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of yRoom!.conns.keys()) {
        if (conn !== origin && conn.readyState === WebSocket.OPEN) conn.send(message);
      }
    });
    yRooms.set(roomId, yRoom);
  }
  return yRoom;
}

function setupYjsConnection(ws: WebSocket, roomId: string) {
  if (!getRoom(roomId)) {
    ws.close(1008, 'Комната не найдена');
    return;
  }
  const yRoom = getYRoom(roomId);
  yRoom.conns.set(ws, new Set());

  ws.on('message', (message: Buffer) => {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(new Uint8Array(message));
    const messageType = decoding.readVarUint(decoder);

    if (messageType === messageSync) {
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, yRoom.doc, ws);
      const reply = encoding.toUint8Array(encoder);
      if (reply.length > 1 && ws.readyState === WebSocket.OPEN) ws.send(reply);
      return;
    }

    if (messageType === messageAwareness) {
      const update = decoding.readVarUint8Array(decoder);
      const controlledIds = yRoom.conns.get(ws);
      if (controlledIds) {
        const updateDecoder = decoding.createDecoder(update);
        const len = decoding.readVarUint(updateDecoder);
        for (let i = 0; i < len; i += 1) {
          controlledIds.add(decoding.readVarUint(updateDecoder));
          decoding.readVarUint(updateDecoder);
          decoding.readVarString(updateDecoder);
        }
      }
      applyAwarenessUpdate(yRoom.awareness, update, ws);
    }
  });

  ws.on('close', () => {
    const controlledIds = yRoom.conns.get(ws);
    yRoom.conns.delete(ws);
    if (controlledIds) removeAwarenessStates(yRoom.awareness, Array.from(controlledIds), ws);
  });

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, yRoom.doc);
  ws.send(encoding.toUint8Array(encoder));

  const states = Array.from(yRoom.awareness.getStates().keys());
  if (states.length > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, messageAwareness);
    encoding.writeVarUint8Array(awarenessEncoder, encodeAwarenessUpdate(yRoom.awareness, states));
    ws.send(encoding.toUint8Array(awarenessEncoder));
  }
}
