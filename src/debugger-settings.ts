import { notify } from './notifications';
import { t } from './localization';

// Settings > Debugger, on Windows only: Glist's tools have no debugger there,
// so Glist Studio installs GDB from MSYS2, each package checked against its
// pinned SHA-256. Debug offers the same when it finds none.

const section = (): HTMLElement | null => document.querySelector('#debugger-settings');
const state = (): HTMLElement | null => document.querySelector('#debugger-state');
const button = (): HTMLButtonElement | null => document.querySelector('#debugger-install');

let status: GlistDebuggerStatus | null = null;
let installing = false;

const describe = (): void => {
  const node = section();
  if (node) node.hidden = !status?.offered;
  if (!status?.offered) return;
  const text = state();
  if (text) {
    text.textContent = status.installed
      ? t('debuggerInstalledText').replace('{name}', status.name).replace('{version}', status.version)
      : t('debuggerNotInstalled').replace('{name}', status.name).replace('{size}', `${Math.round(status.size / 1e6)} MB`);
  }
  const install = button();
  if (install) install.hidden = status.installed;
};

// True once GDB is there, for Debug to go on.
export const installGdb = async (): Promise<boolean> => {
  if (installing) return false;
  installing = true;
  const install = button();
  if (install) install.disabled = true;
  const stop = window.glistAPI.onDebuggerInstall((text) => {
    const percent = /(\d+)%/.exec(text)?.[1];
    const line = state();
    if (percent && line) line.textContent = t('installingDebugger').replace('{percent}', percent);
  });
  const result = await window.glistAPI.installDebugger().catch((error: Error) => ({ success: false, message: error.message }));
  stop();
  installing = false;
  if (install) install.disabled = false;
  status = await window.glistAPI.debuggerStatus().catch(() => status);
  describe();
  notify(result.success ? { text: t('debuggerReady'), kind: 'success' } : { text: t('debuggerInstallFailed'), detail: result.message, kind: 'error' });
  return result.success;
};

export const setUpDebuggerSettings = async (): Promise<void> => {
  button()?.addEventListener('click', () => { void installGdb(); });
  status = await window.glistAPI.debuggerStatus().catch((): null => null);
  describe();
};
