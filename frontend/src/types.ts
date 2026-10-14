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
  users: User[];
  lastRun: RunResult;
};

export type ClientMessage =
  | { type: 'joinRoom'; roomId: string; clientId: string; name: string; color?: string }
  | { type: 'leaveRoom'; roomId: string; clientId: string }
  | { type: 'createFile'; roomId: string; name: string; content?: string }
  | { type: 'renameFile'; roomId: string; fileId: string; name: string }
  | { type: 'deleteFile'; roomId: string; fileId: string }
  | { type: 'runCode'; roomId: string; fileId: string; content?: string }
  | { type: 'stopCode'; roomId: string };

export type ServerMessage =
  | { type: 'roomState'; room: RoomState }
  | { type: 'usersUpdated'; users: User[] }
  | { type: 'filesUpdated'; files: RoomFile[] }
  | { type: 'runStarted'; result: RunResult }
  | { type: 'runFinished'; result: RunResult }
  | { type: 'error'; message: string };
