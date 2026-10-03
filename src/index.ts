import { cpSync, existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, utilityProcess, type IpcMainInvokeEvent, type MenuItemConstructorOptions,
} from 'electron';
import { eventChannels, invokeChannels, type InvokeMethod } from './api';
import { backendStartArgument, type BackendStart, type FromBackend, type ToBackend } from './backend-protocol';
import { isLanguage, languages, type Language, type Words } from './languages';
import { defaultProjectsDirectory, studioHome } from './studio-places';
import {
  checkForUpdates, installOnQuit, installUpdate, openUpdatePage, releaseHold, restartingToUpdate, rollBack, rollbackChoices, setUpdateListener,
  source, updateState,
} from './updater';
import { githubCommitPage } from './repository-head';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
// The commit the app was built from (webpack.main.config.ts), empty when unknown.
declare const GLIST_STUDIO_COMMIT: string;


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

// One Glist Studio runs at a time, for each folder it keeps its settings in:
// starting it again brings its window forward instead of opening the saved
// windows twice.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

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

// The interface language, which the window sets, for the main process's own dialogs.
let language: Language = 'en';
const msg = (key: keyof Words['studio']): string => languages[language].studio[key];

// Each window's backend runs in a utility process of its own (backend.ts), so
// one window's project, builds, terminals and clangd never meet another's.
// Calls from the window come here and go on to its backend, which answers;
// what it sends the window goes straight there; what only Electron can do, it
// asks of this process.
const commit = typeof GLIST_STUDIO_COMMIT === 'string' && GLIST_STUDIO_COMMIT ? GLIST_STUDIO_COMMIT : null;
const commitPage = commit ? githubCommitPage(`${source.site}/${source.repository}`, commit) : undefined;
const backendStart: BackendStart = {
  templateRoot: app.isPackaged
    ? path.join(process.resourcesPath, 'glistapp-template')
    : path.join(app.getAppPath(), 'glistapp-template'),
  projectsDirectory: defaultProjectsDirectory(),
  version: app.getVersion(),
  studioHead: commit ? { branch: null, commit, ...(commitPage ? { commitPage } : {}) } : null,
};

// What a window told its backend that a new one would need, if that one
// stopped: the last of each setting it sent, and the project it opened.
const settingCalls = new Set(['setLanguage', 'setCustomPath', 'setCustomEnvironment', 'setRunArguments', 'setAutoConfigure', 'setTarget', 'gitProtection', 'setHiddenFolders', 'setTerminalShell']);
const projectCalls = new Set(['openProject', 'openProjectPath', 'createProject']);
interface WindowMemory { settings: Map<string, unknown[]>; projectRoot: string | null }
const memories = new Map<number, WindowMemory>();
const remember = (contentsId: number, method: string, args: unknown[], result: unknown): void => {
  const memory = memories.get(contentsId);
  if (!memory) return;
  if (settingCalls.has(method)) memory.settings.set(method, args);
  const root = (result as { root?: unknown } | null)?.root;
  if (projectCalls.has(method) && typeof root === 'string') {
    memory.projectRoot = root;
    scheduleSavingWindows();
  }
};

// Windows: one project each, and never one project in two. Which windows are
// open, with what, where and how large, is kept in windows.json in Glist
// Studio's folder and opened again on the next start. A window made for a
// project opens it once its page asks (windowProject).
type FirstProject = { kind: 'open'; root: string } | { kind: 'create'; template: string; name: string };
const firstProjects = new Map<number, FirstProject>();
interface SavedWindow { root: string; bounds?: Electron.Rectangle; maximized?: boolean }
const windowsFile = (): string => path.join(studioHome(), 'windows.json');

// Folders compare without case except on Linux, whose file systems keep it.
const sameFolder = (left: string, right: string): boolean => {
  const fold = (value: string): string => (process.platform === 'linux' ? path.resolve(value) : path.resolve(value).toLowerCase());
  return fold(left) === fold(right);
};
const windowWithProject = (root: string): BrowserWindow | undefined => BrowserWindow.getAllWindows().find((window) => {
  const open = memories.get(window.webContents.id)?.projectRoot;
  return open !== null && open !== undefined && sameFolder(open, root);
});
const bringForward = (window: BrowserWindow): void => {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

// Quitting keeps the list as it was, rather than emptying it as windows close.
let quitting = false;
let savingWindows: NodeJS.Timeout | null = null;
const saveWindows = (): void => {
  if (quitting) return;
  const saved: SavedWindow[] = BrowserWindow.getAllWindows().flatMap((window) => {
    const root = memories.get(window.webContents.id)?.projectRoot;
    return root ? [{ root, bounds: window.getNormalBounds(), maximized: window.isMaximized() }] : [];
  });
  try {
    mkdirSync(studioHome(), { recursive: true });
    writeFileSync(windowsFile(), JSON.stringify(saved, null, 2), 'utf8');
  } catch {
    // Glist Studio's folder cannot be written; the windows are not opened again.
  }
};
const scheduleSavingWindows = (): void => {
  if (savingWindows) clearTimeout(savingWindows);
  savingWindows = setTimeout(saveWindows, 400);
};

// The windows saved, the ones whose project is still there, each once.
const savedWindows = (): SavedWindow[] => {
  try {
    const saved = JSON.parse(readFileSync(windowsFile(), 'utf8')) as SavedWindow[];
    return (Array.isArray(saved) ? saved : []).filter((entry, index, all) => typeof entry?.root === 'string' && existsSync(entry.root)
      && all.findIndex((other) => sameFolder(other.root, entry.root)) === index);
  } catch {
    return [];
  }
};
// A saved place still on one of the screens, or none.
const onScreen = (bounds: Electron.Rectangle | undefined): Electron.Rectangle | undefined => (bounds
  && screen.getAllDisplays().some(({ workArea: area }) => bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
    && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y) ? bounds : undefined);

// Where a project the window asked for opens: the window that has it already,
// this one too, comes forward; a window without one opens it; one with another
// opens a new window.
const openWhere = async (event: IpcMainInvokeEvent, root: string, open: () => Promise<unknown>): Promise<unknown> => {
  const already = windowWithProject(root);
  if (already) { bringForward(already); return null; }
  if (memories.get(event.sender.id)?.projectRoot) { createWindow({ kind: 'open', root }); return null; }
  return open();
};

interface Backend {
  call(method: string, args: unknown[]): Promise<unknown>;
  // Stops what it started, waiting for it at most three seconds.
  shutdown(): Promise<void>;
}
const backends = new Map<number, Backend>();

const startBackend = (window: BrowserWindow): Backend => {
  const contents = window.webContents;
  const child = utilityProcess.fork(path.join(__dirname, 'backend.js'), [`${backendStartArgument}${JSON.stringify(backendStart)}`], {
    serviceName: 'Glist Studio backend', stdio: 'inherit',
  });
  const post = (message: ToBackend): void => child.postMessage(message);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let calls = 0;
  let stopping = false;
  const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()); });
  child.on('message', (message: FromBackend) => {
    if (message.kind === 'reply') {
      const waiting = pending.get(message.reply.id);
      pending.delete(message.reply.id);
      if ('error' in message.reply) waiting?.reject(new Error(message.reply.error));
      else waiting?.resolve(message.reply.result);
    } else if (message.kind === 'event') {
      if (!contents.isDestroyed()) contents.send(message.channel, message.payload);
    } else if (message.kind === 'host') {
      const done = (error?: unknown): void => post({ kind: 'host-reply', id: message.id, ...(error ? { error: String(error) } : {}) });
      if (message.op === 'showItemInFolder') { shell.showItemInFolder(message.path); done(); }
      else if (message.op === 'trash') shell.trashItem(message.path).then(() => done(), done);
      else shell.openPath(message.path).then((problem) => done(problem || undefined), done);
    }
  });
  // A backend that stops by itself is started again for the window, given its
  // settings and its project again, and then the window is told.
  child.once('exit', (code) => {
    pending.forEach((waiting) => waiting.reject(new Error(`Glist Studio's backend stopped (${code}).`)));
    pending.clear();
    if (stopping || window.isDestroyed()) return;
    const next = startBackend(window);
    const memory = memories.get(contents.id);
    const restored = (async () => {
      for (const [method, args] of memory?.settings ?? []) await next.call(method, args).catch((): undefined => undefined);
      if (memory?.projectRoot) await next.call('openProjectPath', [memory.projectRoot]).catch((): undefined => undefined);
    })();
    // The window's calls wait until then: before it, reading an open file would fail and close its tab.
    backends.set(contents.id, { ...next, call: (method, args) => restored.then(() => next.call(method, args)) });
    void restored.then(() => { if (!contents.isDestroyed()) contents.send(eventChannels.onBackendRestarted, null); });
  });
  return {
    call: (method, args) => new Promise((resolve, reject) => {
      calls += 1;
      pending.set(calls, { resolve, reject });
      post({ kind: 'call', call: { id: calls, method, args } });
    }),
    shutdown: () => {
      if (!stopping) {
        stopping = true;
        post({ kind: 'shutdown' });
        setTimeout(() => child.kill(), 3000).unref();
      }
      return exited;
    },
  };
};

const backendFor = (event: IpcMainInvokeEvent): Backend => {
  const backend = backends.get(event.sender.id);
  if (!backend) throw new Error('This window has no backend.');
  return backend;
};

// A call to the window's backend, remembered when a new backend would need it.
const forward = async (event: IpcMainInvokeEvent, method: string, args: unknown[]): Promise<unknown> => {
  const result = await backendFor(event).call(method, args);
  remember(event.sender.id, method, args, result);
  return result;
};

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
  // The menu bar is the focused window's: each window's is kept, and shown while it has the focus.
  const menu = Menu.buildFromTemplate(template);
  windowMenus.set(sender.id, menu);
  if (BrowserWindow.fromWebContents(sender)?.isFocused() || !BrowserWindow.getFocusedWindow()) Menu.setApplicationMenu(menu);
  return true;
};
const windowMenus = new Map<number, Electron.Menu>();
app.on('browser-window-focus', (_event, window) => {
  const menu = windowMenus.get(window.webContents.id);
  if (menu) Menu.setApplicationMenu(menu);
});

// The title bar is 35px of the page, so it grows and shrinks with the zoom on
// screen, while the window's own buttons do not: Windows' are made as tall as
// the bar, and a Mac's are kept in its middle, where y 10 puts them at 100%.
const titleBarHeight = (zoom: number): number => Math.round(35 * zoom);
const fitWindowControls = (window: BrowserWindow | null, zoom: number): void => {
  if (windowControls === 'right') window?.setTitleBarOverlay({ height: titleBarHeight(zoom) });
  else if (windowControls === 'left') window?.setWindowButtonPosition({ x: 12, y: Math.round((titleBarHeight(zoom) - 15) / 2) });
};

// What the main process answers itself: windows, dialogs, menus and updates.
// Every other call goes to the window's backend.
// The calls the main process answers itself: windows, dialogs, menus and
// updates, and the language, which its dialogs use too. Every other call goes
// on to the window's backend.
type OwnHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown;
const ownHandlers: Partial<Record<InvokeMethod, OwnHandler>> = {
  setLanguage: async (event, next: unknown) => {
    const chosen = await forward(event, 'setLanguage', [next]);
    if (isLanguage(chosen)) language = chosen;
    return chosen;
  },
  setTheme: (event, colors: GlistWindowColors) => {
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
  },
  openProject: async (event) => {
    const defaultPath = String(await backendFor(event).call('getProjectsDirectory', []));
    const result = await dialog.showOpenDialog({
      title: msg('openTitle'),
      defaultPath: existsSync(defaultPath) ? defaultPath : undefined,
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const root = result.filePaths[0];
    return openWhere(event, root, () => forward(event, 'openProject', [root]));
  },
  openProjectPath: (event, root: string) => openWhere(event, root, () => forward(event, 'openProjectPath', [root])),
  createProject: (event, template: string, name: string) => {
    if (!memories.get(event.sender.id)?.projectRoot) return forward(event, 'createProject', [template, name]);
    createWindow({ kind: 'create', template, name });
    return null;
  },
  windowProject: (event) => {
    const first = firstProjects.get(event.sender.id) ?? null;
    firstProjects.delete(event.sender.id);
    return first;
  },
  newWindow: () => { createWindow(); },
  // The project's window closes, unless it is the last: that one stays, with
  // a new backend and no project.
  closeProject: (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (BrowserWindow.getAllWindows().length > 1) { window.close(); return; }
    void backends.get(event.sender.id)?.shutdown();
    memories.set(event.sender.id, { settings: new Map(), projectRoot: null });
    backends.set(event.sender.id, startBackend(window));
    saveWindows();
    window.webContents.reload();
  },
  openEngineSite: () => shell.openExternal('https://www.glistengine.com/'),
  openEngineRepository: () => shell.openExternal('https://github.com/GlistEngine/GlistEngine'),
  setAppMenu: (event, menus: GlistAppMenu[], words: GlistAppMenuWords) => setAppMenu(event.sender, menus, words),
  chooseFolder: async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: msg('pathFolderTitle'), properties: ['openDirectory' as const] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  startupSettings: () => ({ saved: readStartup(), running: runningStartup }),
  setStartupSettings: async (_event, next: unknown): Promise<GlistStartupSettings> => {
    const settings = { hardwareAcceleration: (next as Partial<GlistStartupSettings> | null)?.hardwareAcceleration !== false };
    await fs.mkdir(studioHome(), { recursive: true });
    await fs.writeFile(startupFile(), JSON.stringify(settings, null, 2), 'utf8');
    return settings;
  },
  updateState: () => updateState(),
  checkForUpdates: (_event, previews?: unknown) => checkForUpdates(previews),
  installUpdate: () => installUpdate(),
  openUpdatePage: () => openUpdatePage(),
  rollbackChoices: (_event, previews?: unknown) => rollbackChoices(previews),
  rollBack: (_event, version?: unknown) => rollBack(version),
  releaseHold: (_event, previews?: unknown) => releaseHold(previews),
  setZoomFactor: (event, factor: number) => {
    const safeFactor = Number.isFinite(factor) ? Math.min(3, Math.max(0.5, factor)) : 1;
    event.sender.setZoomFactor(safeFactor);
    fitWindowControls(BrowserWindow.fromWebContents(event.sender), safeFactor);
    return safeFactor;
  },
};

const registerIpcHandlers = (): void => {
  Object.entries(invokeChannels).forEach(([method, channel]) => {
    const own = ownHandlers[method as InvokeMethod] as ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined;
    ipcMain.handle(channel, (event, ...args) => (own ? own(event, ...args) : forward(event, method, args)));
  });
};

// A window and its backend; with a project to open first, and where it was last time.
const createWindow = (first?: FirstProject, saved?: SavedWindow): BrowserWindow => {
  const runtimeMessages: string[] = [];
  const place = onScreen(saved?.bounds);
  const createdWindow = new BrowserWindow({
    width: place?.width ?? 1440, height: place?.height ?? 900, ...(place ? { x: place.x, y: place.y } : {}), minWidth: 980, minHeight: 640,
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
  if (saved?.maximized) createdWindow.maximize();
  if (first) firstProjects.set(createdWindow.webContents.id, first);
  memories.set(createdWindow.webContents.id, { settings: new Map(), projectRoot: null });
  backends.set(createdWindow.webContents.id, startBackend(createdWindow));
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
  const contentsId = createdWindow.webContents.id;
  createdWindow.on('move', scheduleSavingWindows);
  createdWindow.on('resize', scheduleSavingWindows);
  createdWindow.on('closed', () => {
    void backends.get(contentsId)?.shutdown();
    backends.delete(contentsId);
    memories.delete(contentsId);
    firstProjects.delete(contentsId);
    windowMenus.delete(contentsId);
    // A window closed while quitting, once its files were saved, lets quitting go on.
    if (quitting) app.quit();
    else saveWindows();
  });
  return createdWindow;
};

setUpdateListener((update) => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(eventChannels.onUpdateState, update));
});

// The saved windows, or one empty window when there are none.
const restoreWindows = (): void => {
  const saved = savedWindows();
  if (saved.length === 0) createWindow();
  saved.forEach((entry) => createWindow({ kind: 'open', root: entry.root }, entry));
};

// macOS sends activate when the app is opened or its Dock icon clicked, also while
// it is starting, before Electron is ready, as on a first launch after installing.
// Only once the first window is made does activate bring one back.
let started = false;
app.whenReady().then(() => {
  if (!firstInstance) return;
  registerIpcHandlers();
  restoreWindows();
  started = true;
});
app.on('before-quit', () => { saveWindows(); quitting = true; });
// On macOS the app stays open without windows, unless it is restarting to update.
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || restartingToUpdate()) app.quit(); });
// Quitting waits for every backend to stop what it started, so no clangd,
// shell or program outlives the app; then an update downloaded meanwhile installs.
let backendsStopped = false;
app.on('will-quit', (event) => {
  if (!backendsStopped && backends.size > 0) {
    event.preventDefault();
    void Promise.all([...backends.values()].map((backend) => backend.shutdown())).then(() => {
      backendsStopped = true;
      backends.clear();
      app.quit();
    });
    return;
  }
  installOnQuit();
});
app.on('activate', () => { if (started && BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('second-instance', () => {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (window) bringForward(window);
  else if (started) createWindow();
});
