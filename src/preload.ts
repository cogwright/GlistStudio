import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { eventChannels, invokeChannels } from './api';

const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const api: Record<string, unknown> = {};
Object.entries(invokeChannels).forEach(([method, channel]) => {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
});
Object.entries(eventChannels).forEach(([method, channel]) => {
  api[method] = (callback: (payload: unknown) => void) => subscribe(channel, callback);
});

contextBridge.exposeInMainWorld('glistAPI', api);
// A dropped file's path, which pages no longer get from the File itself.
contextBridge.exposeInMainWorld('glistFiles', { pathForFile: (file: File) => webUtils.getPathForFile(file) });

// The main process says where the window buttons are, so the title bar can make room.
const windowControls = process.argv.find((arg) => arg.startsWith('--window-controls='))?.split('=')[1];
window.addEventListener('DOMContentLoaded', () => {
  if (windowControls) document.documentElement.dataset.windowControls = windowControls;
});
