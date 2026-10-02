import { accessSync, constants, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { studioHome } from './studio';
import {
  assetFor, download, installMacApp, newerRelease, replaceAppImage, runWindowsSetup, stageMacApp,
} from './update-release';

// Glist Studio updating itself from its published GitHub releases. A newer
// release is downloaded in the background and checked against GitHub's
// checksum, then installed when the app quits, or at once with Restart to
// Update. The renderer decides when to check (updates.ts).

export const source = { site: 'https://github.com', api: 'https://api.github.com', repository: 'umttur/GlistStudio' };

interface Staged {
  version: string;
  install(relaunch: boolean): void;
}

let state: GlistUpdateState = { state: 'idle' };
let checking: Promise<GlistUpdateState> | null = null;
let staged: Staged | null = null;
let restartRequested = false;
let listener: (update: GlistUpdateState) => void = () => undefined;

const publish = (next: Omit<GlistUpdateState, 'current'>): GlistUpdateState => {
  state = { ...next, current: app.getVersion() };
  listener(state);
  return state;
};

const writable = (folder: string): boolean => {
  try { accessSync(folder, constants.W_OK); return true; } catch { return false; }
};

type Place = { kind: 'mac'; bundle: string } | { kind: 'windows' } | { kind: 'appimage'; file: string };

// Where this copy can replace itself, or null when only the download page can
// help: macOS running it from the disk image or a quarantined download, a copy
// not installed by its installer, or a folder this user cannot write to.
const placeToInstall = (): Place | null => {
  if (process.platform === 'darwin') {
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return null;
    return writable(path.dirname(bundle)) && writable(bundle) ? { kind: 'mac', bundle } : null;
  }
  if (process.platform === 'win32') {
    return existsSync(path.resolve(path.dirname(process.execPath), '..', 'Update.exe')) ? { kind: 'windows' } : null;
  }
  const file = process.env.APPIMAGE;
  return process.platform === 'linux' && file && writable(path.dirname(file)) ? { kind: 'appimage', file } : null;
};

const updatesFolder = (): string => path.join(studioHome(), 'updates');

// Previews: prereleases too, for those who asked for them in Settings.
const check = async (previews: boolean): Promise<GlistUpdateState> => {
  if (!app.isPackaged) return publish({ state: 'unavailable' });
  if (staged) return publish({ state: 'ready', version: staged.version });
  publish({ state: 'checking' });
  try {
    const release = await newerRelease(source, app.getVersion(), previews);
    if (!release) {
      // What an earlier version downloaded has been installed, or is no longer the latest.
      await fs.rm(updatesFolder(), { recursive: true, force: true });
      return publish({ state: 'up-to-date' });
    }
    const asset = assetFor(release.assets, process.platform, process.arch);
    const place = placeToInstall();
    if (!asset || !place) return publish({ state: 'available', version: release.version, page: release.page });
    publish({ state: 'downloading', version: release.version });
    if (place.kind === 'appimage') {
      // Beside the running AppImage, on the same disk, so installing is one rename.
      const next = path.join(path.dirname(place.file), `.${path.basename(place.file)}.update`);
      await download(asset, next);
      await fs.chmod(next, 0o755);
      staged = { version: release.version, install: (relaunch) => replaceAppImage(next, place.file, relaunch) };
    } else {
      const folder = path.join(updatesFolder(), release.version);
      await fs.mkdir(folder, { recursive: true });
      const file = path.join(folder, asset.name);
      await download(asset, file);
      if (place.kind === 'mac') {
        const bundle = await stageMacApp(file, release.version);
        staged = { version: release.version, install: (relaunch) => installMacApp(bundle, place.bundle, process.pid, relaunch) };
      } else {
        // Squirrel's setup starts the app when it is done, so it only runs when asked to.
        staged = { version: release.version, install: (relaunch) => { if (relaunch) runWindowsSetup(file); } };
      }
    }
    return publish({ state: 'ready', version: release.version });
  } catch (error) {
    return publish({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
  }
};

export const setUpdateListener = (next: (update: GlistUpdateState) => void): void => { listener = next; };

export const updateState = (): GlistUpdateState => (app.isPackaged ? { ...state, current: app.getVersion() } : { state: 'unavailable' });

// A check already running is joined rather than started again.
export const checkForUpdates = (previews?: unknown): Promise<GlistUpdateState> => {
  if (!checking) checking = check(previews === true).finally(() => { checking = null; });
  return checking;
};

// Restart to Update: quitting asks about unsaved files as usual, then installs.
export const installUpdate = (): void => {
  if (!staged) return;
  restartRequested = true;
  app.quit();
};

// Unsaved files kept the app open, so the restart is off.
export const quitCancelled = (): void => { restartRequested = false; };

export const restartingToUpdate = (): boolean => restartRequested;

export const openUpdatePage = (): void => {
  if (state.page?.startsWith(`${source.site}/${source.repository}/`)) void shell.openExternal(state.page);
};

// On quit: a downloaded update takes the app's place, and opens if that was asked.
export const installOnQuit = (): void => {
  if (!staged) return;
  try {
    staged.install(restartRequested);
  } catch {
    // It stays downloaded, and the next start offers it again.
  }
  staged = null;
};
