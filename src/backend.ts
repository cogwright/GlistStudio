import { backendStartArgument, type BackendStart, type FromBackend, type ToBackend } from './backend-protocol';
import { initializeStudio } from './studio';
import { answer, backendHandlers, stopBackend } from './studio-rpc';

// One window's backend, in a utility process of its own that the main process
// starts with the window (index.ts): its project, builds, runs, terminals,
// debugger and clangd, apart from every other window's. It hears calls from
// the window and answers them, sends the window its events, and asks the main
// process for what only Electron does, such as moving a file to the trash.

const port = process.parentPort;
const post = (message: FromBackend): void => port.postMessage(message);
const start = JSON.parse(process.argv.find((arg) => arg.startsWith(backendStartArgument))?.slice(backendStartArgument.length) ?? '{}') as BackendStart;

const asked = new Map<number, { resolve(): void; reject(error: Error): void }>();
let askedCount = 0;
const askMain = (op: 'trash' | 'showItemInFolder' | 'openPath', target: string): Promise<void> => new Promise((resolve, reject) => {
  askedCount += 1;
  asked.set(askedCount, { resolve, reject });
  post({ kind: 'host', id: askedCount, op, path: target });
});

initializeStudio({
  send: (channel, payload) => post({ kind: 'event', channel, payload }),
  trashItem: (entryPath) => askMain('trash', entryPath),
  showItemInFolder: (entryPath) => { void askMain('showItemInFolder', entryPath); },
  openPath: (entryPath) => askMain('openPath', entryPath),
  templateRoot: start.templateRoot,
  projectsDirectory: start.projectsDirectory,
  version: start.version,
  studioHead: async () => start.studioHead,
});

port.on('message', ({ data }: { data: ToBackend }) => {
  if (data.kind === 'call') void answer(backendHandlers, data.call).then((reply) => post({ kind: 'reply', reply }));
  else if (data.kind === 'host-reply') {
    const waiting = asked.get(data.id);
    asked.delete(data.id);
    if (data.error) waiting?.reject(new Error(data.error));
    else waiting?.resolve();
  } else if (data.kind === 'shutdown') {
    stopBackend();
    process.exit(0);
  }
});
