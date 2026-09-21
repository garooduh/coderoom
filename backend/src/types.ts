export type FileLanguage = 'python' | 'plaintext';

export type RoomFile = {
  id: string;
  name: string;
  language: FileLanguage;
  content: string;
};

export type User = {
  clientId: string;
  name: string;
  color: string;
};

export type RunResult = {
  status: 'idle' | 'running' | 'success' | 'error' | 'stopped';
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type RoomState = {
  roomId: string;
  files: RoomFile[];
  activeFileId: string;
  users: User[];
  lastRun: RunResult;
};

export type Room = RoomState & {
  clients: Map<string, import('ws').WebSocket>;
};

export type ClientMessage =
  | { type: 'joinRoom'; roomId: string; clientId: string; name: string; color?: string }
  | { type: 'leaveRoom'; roomId: string; clientId: string }
  | { type: 'createFile'; roomId: string; name: string; content?: string }
  | { type: 'renameFile'; roomId: string; fileId: string; name: string }
  | { type: 'deleteFile'; roomId: string; fileId: string }
  | { type: 'selectFile'; roomId: string; fileId: string }
  | { type: 'runCode'; roomId: string; fileId: string; content?: string }
  | { type: 'stopCode'; roomId: string };
