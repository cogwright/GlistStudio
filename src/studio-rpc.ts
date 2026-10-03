import type { Handler, Handlers } from './api';
import {
  openProjectAt, stopClangd, stopDebugging, stopGit, stopProcesses, stopTerminal, stopWatchingConfiguration, studio,
} from './studio';

// The backend as a window reaches it from elsewhere, over messages: the
// browser build's server (web/server.ts) and the process each of the app's
// windows has (backend.ts) answer calls the same way here. Opening a project
// takes its folder, which the app's main process asks for with a dialog first.

export const backendHandlers: Handlers = { ...studio, openProject: (projectRoot: string) => openProjectAt(projectRoot) };

export interface BackendCall {
  id: number;
  method: string;
  args: unknown[];
}

// An error's message is all of it that survives the way back.
export type BackendReply = { id: number; result: unknown } | { id: number; error: string };

export const answer = async (handlers: Handlers, { id, method, args }: BackendCall): Promise<BackendReply> => {
  const handler = (handlers as Record<string, Handler | undefined>)[method];
  try {
    if (!handler) throw new Error(`Unknown method ${method}`);
    return { id, result: (await handler(...args)) ?? null };
  } catch (error) {
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
};

// Everything the backend started, stopped: the program, builds, the debugger,
// clangd, terminals, git and the watchers.
export const stopBackend = (): void => {
  stopProcesses(); stopClangd(); stopDebugging(); stopTerminal(); stopGit(); stopWatchingConfiguration();
};
