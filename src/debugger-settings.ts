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

// Also when the language changes.
export const describeDebugger = (): void => {
  const node = section();
  if (node) node.hidden = !status?.offered;
  if (!status?.offered) return;
  const text = state();
  if (text) {
    text.textContent = status.installed
      ? t('debuggerInstalledText').replace('{name}', status.name).replace('{version}', status.version)
      : t('debuggerNotInstalled').replace('{name}', status.name).replace('{size}', `${Math.round(status.size / 1e6)} MB`);
  }
  // Installed, the same button installs it again, for one that does not start.
  const install = button();
  if (install) install.textContent = t(status.installed ? 'installDebuggerAgain' : 'installDebugger');
};

// True once GDB is there, for Debug to go on. Again: the installed one is replaced.
export const installGdb = async (again = false): Promise<boolean> => {
  if (installing) return false;
  installing = true;
  const install = button();
  if (install) install.disabled = true;
  const stop = window.glistAPI.onDebuggerInstall((text) => {
    const percent = /(\d+)%/.exec(text)?.[1];
    const line = state();
    if (percent && line) line.textContent = t('installingDebugger').replace('{percent}', percent);
  });
  const result = await window.glistAPI.installDebugger(again).catch((error: Error) => ({ success: false, message: error.message }));
  stop();
  installing = false;
  if (install) install.disabled = false;
  status = await window.glistAPI.debuggerStatus().catch(() => status);
  describeDebugger();
  notify(result.success ? { text: t('debuggerReady'), kind: 'success' } : { text: t('debuggerInstallFailed'), detail: result.message, kind: 'error' });
  return result.success;
};

export const setUpDebuggerSettings = async (): Promise<void> => {
  button()?.addEventListener('click', () => { void installGdb(Boolean(status?.installed)); });
  status = await window.glistAPI.debuggerStatus().catch((): null => null);
  describeDebugger();
};
