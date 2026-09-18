import { contextBridge, ipcRenderer } from 'electron';

const subscribe = <T>(channel: string, callback: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('glistAPI', {
  openProject: () => ipcRenderer.invoke('project:open'),
  createProject: (templateName: GlistTemplate, projectName: string) =>
    ipcRenderer.invoke('project:create', templateName, projectName),
  listDirectory: (directoryPath: string) => ipcRenderer.invoke('project:list-directory', directoryPath),
  createFile: (directoryPath: string, name: string) =>
    ipcRenderer.invoke('project:create-file', directoryPath, name),
  createDirectory: (directoryPath: string, name: string) =>
    ipcRenderer.invoke('project:create-directory', directoryPath, name),
  deleteEntry: (entryPath: string) => ipcRenderer.invoke('project:delete-entry', entryPath),
  renameEntry: (entryPath: string, newName: string) =>
    ipcRenderer.invoke('project:rename-entry', entryPath, newName),
  createCppClass: (directoryPath: string, className: string) =>
    ipcRenderer.invoke('project:create-cpp-class', directoryPath, className),
  copyEntry: (entryPath: string, destinationDirectory: string) =>
    ipcRenderer.invoke('project:copy-entry', entryPath, destinationDirectory),
  showInExplorer: (entryPath: string) => ipcRenderer.invoke('project:show-in-explorer', entryPath),
  openCommandPrompt: (entryPath: string) => ipcRenderer.invoke('project:open-command-prompt', entryPath),
  readFile: (filePath: string) => ipcRenderer.invoke('project:read-file', filePath),
  writeFile: (filePath: string, contents: string) => ipcRenderer.invoke('project:write-file', filePath, contents),
  buildProject: () => ipcRenderer.invoke('project:build'),
  runProject: () => ipcRenderer.invoke('project:run'),
  stopProject: () => ipcRenderer.invoke('project:stop'),
  setLanguage: (language: GlistLanguage) => ipcRenderer.invoke('settings:set-language', language),
  openEngineSite: () => ipcRenderer.invoke('app:open-engine-site'),
  onBuildOutput: (callback: (text: string) => void) => subscribe('build:output', callback),
  onBuildStatus: (callback: (status: { running: boolean; label: string }) => void) =>
    subscribe('build:status', callback),
  onRunOutput: (callback: (text: string) => void) => subscribe('run:output', callback),
  onRunStatus: (callback: (status: { running: boolean; exitCode?: number }) => void) =>
    subscribe('run:status', callback),
});
