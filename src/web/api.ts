import { eventChannels, invokeChannels } from '../api';

// window.glistAPI for a browser page served by src/web/server.ts.

interface Reply {
  id?: number;
  result?: unknown;
  error?: string;
  channel?: string;
  payload?: unknown;
}

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 1;
let projectsDirectory = '';

const emit = (channel: string, payload: unknown): void => listeners.get(channel)?.forEach((listener) => listener(payload));

const socket = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api`);
const opened = new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));

socket.addEventListener('message', (event: MessageEvent<string>) => {
  const reply = JSON.parse(event.data) as Reply;
  if (reply.channel === 'web:hello') {
    projectsDirectory = (reply.payload as { projectsDirectory: string }).projectsDirectory;
  } else if (reply.channel) {
    emit(reply.channel, reply.payload);
  } else if (reply.id !== undefined) {
    const request = pending.get(reply.id);
    pending.delete(reply.id);
    if (reply.error !== undefined) request?.reject(new Error(reply.error));
    else request?.resolve(reply.result);
  }
});

socket.addEventListener('close', (event) => {
  pending.forEach((request) => request.reject(new Error('Disconnected from Glist Studio.')));
  pending.clear();
  emit(eventChannels.onBuildOutput, `\nDisconnected from the Glist Studio server${event.reason ? `: ${event.reason}` : ''}. Reload to reconnect.\n`);
});

const call = async (method: string, args: unknown[]): Promise<unknown> => {
  await opened;
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, args }));
  });
};

const api: Record<string, unknown> = {};
Object.keys(invokeChannels).forEach((method) => {
  api[method] = (...args: unknown[]) => call(method, args);
});
Object.entries(eventChannels).forEach(([method, channel]) => {
  api[method] = (callback: (payload: unknown) => void) => {
    const channelListeners = listeners.get(channel) ?? new Set();
    listeners.set(channel, channelListeners);
    channelListeners.add(callback);
    return () => channelListeners.delete(callback);
  };
});

const lastProjectKey = 'glist-studio-web-project';
Object.assign(api, {
  // There is no folder picker for the server's disk, so ask for a path.
  openProject: async () => {
    await opened;
    const root = window.prompt('Project folder on the host', window.localStorage.getItem(lastProjectKey) ?? projectsDirectory);
    if (!root) return null;
    const project = await call('openProject', [root]);
    window.localStorage.setItem(lastProjectKey, root);
    return project;
  },
  openEngineSite: async () => { window.open('https://www.glistengine.com/', '_blank', 'noopener'); },
});

window.glistAPI = api as unknown as Window['glistAPI'];
