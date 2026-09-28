import { contextBridge, ipcRenderer } from 'electron';
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

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.windowControls = process.platform === 'darwin' ? 'left' : 'right';
});
