import { notify } from './notifications';
import { t } from './localization';

// Settings > Updates, Help > Check for Updates, and the messages about a new
// version. The Electron app checks, downloads and installs (updater.ts); this
// decides when to check and says what came of it.

const storageKey = 'glist-studio-auto-update';
const checkEvery = 6 * 60 * 60 * 1000;

let supported = false;
// Set by Check for Updates, so that "up to date" and failures are said too.
let asked = false;
const told = new Set<string>();

const automatic = (): boolean => {
  try { return window.localStorage.getItem(storageKey) !== 'off'; } catch { return true; }
};

const describe = (update: GlistUpdateState): void => {
  const version = update.version ?? '';
  const once = (key: string): boolean => {
    if (!asked && told.has(key)) return false;
    told.add(key);
    return true;
  };
  if (update.state === 'ready' && once(`ready ${version}`)) {
    notify({
      text: t('updateReady').replace('{version}', version),
      actions: [{ label: t('restartToUpdate'), run: () => { void window.glistAPI.installUpdate(); } }],
    });
  } else if (update.state === 'available' && once(`available ${version}`)) {
    notify({
      text: t('updateAvailable').replace('{version}', version),
      actions: [{ label: t('updateDownload'), run: () => { void window.glistAPI.openUpdatePage(); } }],
    });
  } else if (asked && update.state === 'up-to-date') {
    notify({ text: t('upToDate'), kind: 'success' });
  } else if (asked && update.state === 'downloading') {
    notify({ text: t('updateDownloading').replace('{version}', version) });
  } else if (asked && update.state === 'failed') {
    notify({ text: t('updateFailed'), detail: update.message, kind: 'error' });
  }
  if (update.state !== 'checking' && update.state !== 'downloading') asked = false;
};

export const canUpdate = (): boolean => supported;

export const checkForUpdates = (): void => {
  asked = true;
  void window.glistAPI.checkForUpdates();
};

export const setUpUpdates = async (): Promise<void> => {
  window.glistAPI.onUpdateState(describe);
  const current = await window.glistAPI.updateState().catch((): GlistUpdateState => ({ state: 'unavailable' }));
  supported = current.state !== 'unavailable';
  const section = document.querySelector<HTMLElement>('#update-settings');
  const toggle = document.querySelector<HTMLInputElement>('#auto-update');
  const version = document.querySelector<HTMLElement>('#update-version');
  if (section) section.hidden = !supported;
  if (!supported) return;
  if (version) version.textContent = `Glist Studio ${current.current ?? ''}`;
  if (toggle) {
    toggle.checked = automatic();
    toggle.addEventListener('change', () => {
      try { window.localStorage.setItem(storageKey, toggle.checked ? 'on' : 'off'); } catch { /* Storage may be unavailable. */ }
      if (toggle.checked) void window.glistAPI.checkForUpdates();
    });
  }
  const quietly = (): void => { if (automatic()) void window.glistAPI.checkForUpdates(); };
  // A moment after starting, so opening the last project comes first.
  window.setTimeout(quietly, 10000);
  window.setInterval(quietly, checkEvery);
};
