import { cpSync, existsSync, mkdirSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { eventChannels, invokeChannels, type Handler, type InvokeMethod } from './api';
import {
  defaultProjectsDirectory, initializeStudio, msg, openProjectAt, projectsDirectory, stopClangd, stopDebugging, stopProcesses,
  stopGit, stopTerminal, stopWatchingConfiguration, studio, studioHome,
} from './studio';
import {
  checkForUpdates, installOnQuit, installUpdate, openUpdatePage, restartingToUpdate, setUpdateListener, source, updateState,
} from './updater';
import { githubCommitPage } from './repository-head';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
// The commit the app was built from (webpack.main.config.ts), empty when unknown.
declare const GLIST_STUDIO_COMMIT: string;

let mainWindow: BrowserWindow | null = null;

if (require('electron-squirrel-startup')) app.quit();

// Settings and everything else the window keeps live in the Glist folder, next
// to the engine and the projects, instead of the system's app data folder.
// Settings saved in the old place come along the first time.
const useGlistFolder = (): void => {
  const target = path.join(studioHome(), 'data');
  const previous = app.getPath('userData');
  if (path.resolve(previous) === path.resolve(target)) return;
  try {
    const storage = path.join(previous, 'Local Storage');
    if (!existsSync(target) && existsSync(storage)) cpSync(storage, path.join(target, 'Local Storage'), { recursive: true });
    mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch {
    // The Glist folder cannot be written; the system's app data folder still works.
  }
};
useGlistFolder();

// Settings Electron takes only before it starts, which the window's own storage
// cannot hold: it is not there yet. Settings, under General, writes them.
const startupFile = (): string => path.join(studioHome(), 'startup.json');
const readStartup = (): GlistStartupSettings => {
  try {
    const saved = JSON.parse(readFileSync(startupFile(), 'utf8')) as Partial<GlistStartupSettings>;
    return { hardwareAcceleration: saved.hardwareAcceleration !== false };
  } catch {
    return { hardwareAcceleration: true };
  }
};
const runningStartup = readStartup();
if (!runningStartup.hardwareAcceleration) app.disableHardwareAcceleration();

// Tiling compositors such as Hyprland place, size and close windows themselves,
// so window buttons there only get in the way.
const tilingDesktop = process.platform === 'linux' && (
  /hyprland|sway|i3|river|niri|dwl|qtile|bspwm|awesome|xmonad/i.test(
    `${process.env.XDG_CURRENT_DESKTOP ?? ''}:${process.env.XDG_SESSION_DESKTOP ?? ''}`,
  ) || Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE || process.env.SWAYSOCK || process.env.I3SOCK));

// Where the window buttons sit: macOS draws its own on the left, Windows and
// other Linux desktops get Electron's overlay on the right.
const windowControls = process.platform === 'darwin' ? 'left' : tilingDesktop ? 'none' : 'right';

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
  version: app.getVersion(),
  studioHead: async () => {
    const commit = typeof GLIST_STUDIO_COMMIT === 'string' && GLIST_STUDIO_COMMIT ? GLIST_STUDIO_COMMIT : null;
    const commitPage = commit ? githubCommitPage(`${source.site}/${source.repository}`, commit) : undefined;
    return commit ? { branch: null, commit, ...(commitPage ? { commitPage } : {}) } : null;
  },
});

// A shortcut as the menus write it, as Electron takes it: Ctrl is Cmd on a
// Mac and Control is Control; Ctrl++ is Plus.
const accelerator = (shortcut: unknown): string | undefined => {
  if (typeof shortcut !== 'string' || !shortcut) return undefined;
  const plus = shortcut.endsWith('++');
  const parts = (plus ? shortcut.slice(0, -2) : shortcut).split('+').filter(Boolean);
  const key = plus ? 'Plus' : parts.pop();
  const names: Record<string, string> = { Ctrl: 'CmdOrCtrl', Cmd: 'Cmd', Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt' };
  return [...parts.map((part) => names[part] ?? part), key].join('+');
};

// On macOS the title bar's menus go to the system's menu bar. The renderer
// sends them again whenever what they offer changes, and hears back what was
// chosen. The shortcuts only show there: the renderer keeps handling the keys.
// Edit has the system's Undo, Redo, Cut, Copy, Paste and Select All, which
// text fields need.
const setAppMenu = (sender: Electron.WebContents, menus: GlistAppMenu[], words: GlistAppMenuWords): boolean => {
  if (process.platform !== 'darwin' || !Array.isArray(menus)) return false;
  const send = (id: string): void => { if (!sender.isDestroyed()) sender.send(eventChannels.onMenuCommand, id); };
  const headers = Number.parseInt(process.getSystemVersion(), 10) >= 14;
  const word = (key: keyof GlistAppMenuWords): string => (typeof words?.[key] === 'string' ? words[key] : key);
  const items = (menu: GlistAppMenu): MenuItemConstructorOptions[] => menu.items.flatMap((item): MenuItemConstructorOptions[] => {
    const label = String(item.label ?? '');
    if (item.kind === 'separator') return [{ type: 'separator' }];
    if (item.kind === 'heading') return [headers ? { type: 'header', label } : { label, enabled: false }];
    if (item.role === 'undo' || item.role === 'redo') {
      return item.role === 'undo' ? [{ role: 'undo', label }] : [{ role: 'redo', label }, { type: 'separator' },
        { role: 'cut', label: word('cut') }, { role: 'copy', label: word('copy') }, { role: 'paste', label: word('paste') },
        { role: 'selectAll', label: word('selectAll') }];
    }
    let shortcut: string | undefined;
    try { shortcut = accelerator(item.shortcut); } catch { shortcut = undefined; }
    return [{ label, enabled: item.enabled !== false, accelerator: shortcut, registerAccelerator: false, click: () => send(String(item.id)) }];
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: word('about'), click: () => send('app:about') },
        { type: 'separator' },
        { label: word('settings'), accelerator: 'Cmd+,', click: () => send('app:settings') },
        { type: 'separator' },
        { role: 'services', label: word('services') },
        { type: 'separator' },
        { role: 'hide', label: word('hide') },
        { role: 'hideOthers', label: word('hideOthers') },
        { role: 'unhide', label: word('showAll') },
        { type: 'separator' },
        { role: 'quit', label: word('quit') },
      ],
    },
    ...menus.map((menu): MenuItemConstructorOptions => ({ label: String(menu.label), submenu: items(menu) })),
    {
      role: 'windowMenu',
      label: word('window'),
      submenu: [
        { role: 'minimize', label: word('minimize') },
        { role: 'zoom', label: word('zoom') },
        { type: 'separator' },
        { role: 'front', label: word('front') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return true;
};

// The title bar is 35px of the page, so it grows and shrinks with the zoom on
// screen, while the window's own buttons do not: Windows' are made as tall as
// the bar, and a Mac's are kept in its middle, where y 10 puts them at 100%.
const titleBarHeight = (zoom: number): number => Math.round(35 * zoom);
const fitWindowControls = (window: BrowserWindow | null, zoom: number): void => {
  if (windowControls === 'right') window?.setTitleBarOverlay({ height: titleBarHeight(zoom) });
  else if (windowControls === 'left') window?.setWindowButtonPosition({ x: 12, y: Math.round((titleBarHeight(zoom) - 15) / 2) });
};

const registerIpcHandlers = (): void => {
  Object.entries(studio).forEach(([method, handler]: [string, Handler]) => {
    ipcMain.handle(invokeChannels[method as InvokeMethod], (_event, ...args) => handler(...args));
  });
  ipcMain.handle(invokeChannels.setTheme, (event, colors: GlistWindowColors) => {
    const color = (value: unknown, fallback: string): string =>
      (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);
    const window = BrowserWindow.fromWebContents(event.sender);
    nativeTheme.themeSource = colors?.kind === 'light' ? 'light' : 'dark';
    window?.setBackgroundColor(color(colors?.background, '#1e1e1e'));
    if (windowControls === 'right') window?.setTitleBarOverlay({
      color: color(colors?.chrome, '#181818'),
      symbolColor: color(colors?.text, '#cccccc'),
      height: titleBarHeight(event.sender.getZoomFactor()),
    });
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
  ipcMain.handle(invokeChannels.openEngineRepository, () => shell.openExternal('https://github.com/GlistEngine/GlistEngine'));
  ipcMain.handle(invokeChannels.setAppMenu, (event, menus: GlistAppMenu[], words: GlistAppMenuWords) => setAppMenu(event.sender, menus, words));
  ipcMain.handle(invokeChannels.chooseFolder, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: msg('pathFolderTitle'), properties: ['openDirectory' as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(invokeChannels.startupSettings, () => ({ saved: readStartup(), running: runningStartup }));
  ipcMain.handle(invokeChannels.setStartupSettings, async (_event, next: unknown): Promise<GlistStartupSettings> => {
    const settings = { hardwareAcceleration: (next as Partial<GlistStartupSettings> | null)?.hardwareAcceleration !== false };
    await fs.mkdir(studioHome(), { recursive: true });
    await fs.writeFile(startupFile(), JSON.stringify(settings, null, 2), 'utf8');
    return settings;
  });
  ipcMain.handle(invokeChannels.updateState, () => updateState());
  ipcMain.handle(invokeChannels.checkForUpdates, (_event, previews?: unknown) => checkForUpdates(previews));
  ipcMain.handle(invokeChannels.installUpdate, () => installUpdate());
  ipcMain.handle(invokeChannels.openUpdatePage, () => openUpdatePage());
  ipcMain.handle(invokeChannels.setZoomFactor, (event, factor: number) => {
    const safeFactor = Number.isFinite(factor) ? Math.min(3, Math.max(0.5, factor)) : 1;
    event.sender.setZoomFactor(safeFactor);
    fitWindowControls(BrowserWindow.fromWebContents(event.sender), safeFactor);
    return safeFactor;
  });
};

const createWindow = (): void => {
  const runtimeMessages: string[] = [];
  const createdWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 640,
    backgroundColor: '#1e1e1e', title: 'Glist Studio', autoHideMenuBar: true,
    icon: path.join(
      app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets'),
      process.platform === 'win32' ? 'glistengine.ico' : 'glistengine.png',
    ),
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 10 },
    titleBarOverlay: windowControls === 'right' && {
      color: '#181818',
      symbolColor: '#cccccc',
      height: 35,
    },
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      additionalArguments: [`--window-controls=${windowControls}`],
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
  // Web pages and mail addresses open in the browser and the mail program, never
  // in a window here: commit pages from Settings > About, and a plugin's README's links.
  createdWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The renderer blocks unloading while tabs are unsaved; Electron would then
  // silently refuse to close, so it is told to save them, and closes after.
  createdWindow.webContents.on('will-prevent-unload', () => {
    createdWindow.webContents.send('app:save-and-close', null);
  });
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
  createdWindow.on('closed', () => { stopProcesses(); stopClangd(); stopDebugging(); stopTerminal(); stopGit(); stopWatchingConfiguration(); mainWindow = null; });
};

setUpdateListener((update) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(eventChannels.onUpdateState, update);
});

// macOS sends activate when the app is opened or its Dock icon clicked, also while
// it is starting, before Electron is ready, as on a first launch after installing.
// Only once the first window is made does activate bring one back.
let started = false;
app.whenReady().then(() => { registerIpcHandlers(); createWindow(); started = true; });
// On macOS the app stays open without windows, unless it is restarting to update.
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || restartingToUpdate()) app.quit(); });
app.on('will-quit', installOnQuit);
app.on('activate', () => { if (started && BrowserWindow.getAllWindows().length === 0) createWindow(); });
