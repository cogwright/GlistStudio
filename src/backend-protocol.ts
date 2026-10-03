import type { RepositoryHead } from './repository-head';
import type { BackendCall, BackendReply } from './studio-rpc';

// The messages between the main process and a window's backend process
// (backend.ts), apart from either, so each can import them without the other.

// What the main process gives a backend to start, as one argument.
export const backendStartArgument = '--glist-backend=';

export interface BackendStart {
  templateRoot: string;
  projectsDirectory: string;
  version: string;
  studioHead: RepositoryHead | null;
}

export type ToBackend =
  | { kind: 'call'; call: BackendCall }
  | { kind: 'host-reply'; id: number; error?: string }
  | { kind: 'shutdown' };

// Host requests are what only Electron, in the main process, can do.
export type FromBackend =
  | { kind: 'reply'; reply: BackendReply }
  | { kind: 'event'; channel: string; payload: unknown }
  | { kind: 'host'; id: number; op: 'trash' | 'showItemInFolder' | 'openPath'; path: string };
