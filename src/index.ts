import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { invokeChannels, type Handler, type InvokeMethod } from './api';
import {
  defaultProjectsDirectory, initializeStudio, msg, openProjectAt, projectsDirectory, stopClangd, stopProcesses, studio,
} from './studio';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;

if (require('electron-squirrel-startup')) app.quit();

initializeStudio({
  send: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  },
  trashItem: (entryPath) => shell.trashItem(entryPath),
  showItemInFolder: (entryPath) => shell.showItemInFolder(entryPath),
  openPath: (entryPath) => shell.openPath(entryPath),
  templateRoot: app.isPackaged
    ? path.join(process.resourcesPath, 'glistapp-template')
    : path.join(app.getAppPath(), 'glistapp-template'),
  projectsDirectory: defaultProjectsDirectory(),
});

const registerIpcHandlers = (): void => {
  Object.entries(studio).forEach(([method, handler]: [string, Handler]) => {
    ipcMain.handle(invokeChannels[method as InvokeMethod], (_event, ...args) => handler(...args));
  });
  ipcMain.handle(invokeChannels.setTheme, (event, requestedTheme: 'dark' | 'light') => {
    const theme = requestedTheme === 'light' ? 'light' : 'dark';
    const window = BrowserWindow.fromWebContents(event.sender);
    nativeTheme.themeSource = theme;
    window?.setBackgroundColor(theme === 'light' ? '#ffffff' : '#1e1e1e');
    window?.setTitleBarOverlay({
      color: theme === 'light' ? '#f5f5f5' : '#181818',
      symbolColor: theme === 'light' ? '#333333' : '#cccccc',
      height: 35,
    });
    return theme;
  });
  ipcMain.handle(invokeChannels.openProject, async () => {
    const defaultPath = projectsDirectory();
    const result = await dialog.showOpenDialog({
      title: msg('openTitle'),
      defaultPath: existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return openProjectAt(result.filePaths[0]);
  });
  ipcMain.handle(invokeChannels.openEngineSite, () => shell.openExternal('https://www.glistengine.com/'));
  ipcMain.handle(invokeChannels.setZoomFactor, (event, factor: number) => {
    const safeFactor = Number.isFinite(factor) ? Math.min(2, Math.max(0.5, factor)) : 1;
    event.sender.setZoomFactor(safeFactor);
    return safeFactor;
  });
};

const createWindow = (): void => {
  const runtimeMessages: string[] = [];
  const createdWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 640,
    backgroundColor: '#1e1e1e', title: 'Glist Studio', autoHideMenuBar: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'glistengine.ico')
      : path.join(app.getAppPath(), 'assets', 'glistengine.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#cccccc',
      height: 35,
    },
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = createdWindow;
  createdWindow.webContents.on('console-message', (event, _level, message) => {
    const detailMessage = (event as unknown as { message?: string }).message;
    runtimeMessages.push(detailMessage ?? message);
  });
  createdWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  createdWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== MAIN_WINDOW_WEBPACK_ENTRY) event.preventDefault();
  });
  createdWindow.webContents.once('did-finish-load', () => {
    const screenshotPath = process.env.GLIST_STUDIO_SCREENSHOT;
    if (!screenshotPath) return;
    setTimeout(async () => {
      let diagnostics: unknown;
      try {
        diagnostics = await createdWindow.webContents.executeJavaScript(`({
          scripts: [...document.scripts].map((script) => script.src),
          apiType: typeof window.glistAPI,
          bodyFont: getComputedStyle(document.body).fontFamily,
          shellDisplay: getComputedStyle(document.querySelector('#app-shell')).display
        })`);
      } catch (error) {
        diagnostics = { error: String(error) };
      }
      const image = await createdWindow.webContents.capturePage();
      await fs.writeFile(screenshotPath, image.toPNG());
      await fs.writeFile(
        `${screenshotPath}.json`,
        JSON.stringify({ runtimeMessages, diagnostics }, null, 2),
        'utf8',
      );
      app.quit();
    }, 1000);
  });
  createdWindow.on('closed', () => { stopProcesses(); stopClangd(); mainWindow = null; });
};

app.whenReady().then(() => { registerIpcHandlers(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
