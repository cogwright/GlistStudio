import { t } from './localization';
import type { StudioTerminal } from './terminal';

// Installing Glist Engine: its own installer's output shows in a terminal
// inside a dialog, under a progress bar that follows the steps it reports
// ("==> [3/7] GlistEngine", then "==> Done: ..." or "==> Failed: ..."). A
// password it needs is asked for by the system (see passwordPrompt in studio.ts).

export interface GlistInstallerControls {
  dialog: HTMLDialogElement;
  intro: HTMLElement;
  password: HTMLElement;
  location: HTMLElement;
  progress: HTMLElement;
  bar: HTMLProgressElement;
  step: HTMLElement;
  result: HTMLElement;
  install: HTMLButtonElement;
  openApp: HTMLButtonElement;
  close: HTMLButtonElement;
}

type InstallerState = 'intro' | 'running' | 'done' | 'failed';

// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export const setUpGlistInstaller = (
  controls: GlistInstallerControls,
  terminal: StudioTerminal,
  // Called once Glist is installed, with where it went.
  onInstalled: (root: string) => void,
  openApp: (root: string) => void,
): (() => Promise<void>) => {
  let state: InstallerState = 'intro';
  let root = '';
  let pending = '';
  let failure = '';

  const show = (next: InstallerState): void => {
    state = next;
    controls.intro.hidden = next !== 'intro';
    controls.progress.hidden = next === 'intro';
    controls.install.hidden = next === 'running' || next === 'done';
    controls.install.textContent = t(next === 'failed' ? 'tryAgain' : 'installGlist');
    controls.openApp.hidden = next !== 'done';
    controls.close.textContent = t(next === 'running' ? 'stopInstall' : 'close');
    controls.result.hidden = next !== 'done' && next !== 'failed';
    controls.result.classList.toggle('failed', next === 'failed');
    if (next === 'done') controls.result.textContent = t('glistInstalled');
    if (next === 'failed') controls.result.textContent = `${t('glistInstallFailed')}${failure ? `: ${failure}` : ''}`;
  };

  const follow = (line: string): void => {
    const step = /^==> \[(\d+)\/(\d+)\] (.+)$/.exec(line);
    if (step) {
      controls.bar.max = Number(step[2]);
      controls.bar.value = Number(step[1]) - 1;
      controls.step.textContent = t('installStep').replace('{step}', step[1]).replace('{total}', step[2]).replace('{name}', step[3]);
    }
    const failed = /^==> Failed: (.+)$/.exec(line);
    if (failed) failure = failed[1];
  };

  window.glistAPI.onTerminalData(({ session, data }) => {
    if (session !== 'install') return;
    const lines = (pending + data.replace(ansi, '')).split(/\r?\n|\r/);
    pending = lines.pop() ?? '';
    lines.forEach((line) => follow(line.trim()));
  });
  window.glistAPI.onTerminalExit(({ session, exitCode }) => {
    if (session !== 'install' || state !== 'running') return;
    follow(pending.trim());
    pending = '';
    if (exitCode === 0 && !failure) {
      controls.bar.value = controls.bar.max;
      show('done');
      onInstalled(root);
    } else {
      if (!failure) failure = `${t('exitCode')} ${exitCode}`;
      show('failed');
    }
  });

  controls.install.addEventListener('click', () => {
    failure = '';
    pending = '';
    controls.bar.removeAttribute('value');
    controls.step.textContent = t('installStarting');
    show('running');
    void terminal.run();
  });
  controls.openApp.addEventListener('click', () => {
    controls.dialog.close();
    openApp(root);
  });
  controls.close.addEventListener('click', () => {
    if (state === 'running') {
      if (!window.confirm(t('confirmStopInstall'))) return;
      terminal.stop();
      failure = t('installStopped');
      show('failed');
      return;
    }
    controls.dialog.close();
  });
  // Escape would hide a running installer; it has to be stopped instead.
  controls.dialog.addEventListener('cancel', (event) => { if (state === 'running') event.preventDefault(); });

  return async () => {
    const status = await window.glistAPI.glistStatus();
    root = status.root;
    controls.location.textContent = status.location;
    controls.password.hidden = status.passwordPrompt === 'none';
    controls.password.textContent = status.passwordPrompt === 'terminal' ? t('installPasswordTerminal') : t('installPasswordSystem');
    if (state !== 'running') show('intro');
    controls.dialog.showModal();
  };
};
