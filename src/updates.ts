import { notify } from './notifications';
import { t } from './localization';

// Settings > Updates, Help > Check for Updates, and the messages about a new
// version. The Electron app checks, downloads and installs (updater.ts); this
// decides when to check and says what came of it. Settings can also go back to
// an earlier version, after a warning, and let go of the hold that follows.

const storageKey = 'glist-studio-auto-update';
const previewsKey = 'glist-studio-update-previews';
const checkEvery = 6 * 60 * 60 * 1000;

let supported = false;
// Set by Check for Updates, so that "up to date" and failures are said too.
let asked = false;
const told = new Set<string>();

const automatic = (): boolean => {
  try { return window.localStorage.getItem(storageKey) !== 'off'; } catch { return true; }
};

// Prereleases too, built from every change before a release; off unless chosen.
const previews = (): boolean => {
  try { return window.localStorage.getItem(previewsKey) === 'on'; } catch { return false; }
};

// After going back: which version is held, and Update Again to let go.
const showHold = (update: GlistUpdateState): void => {
  const note = document.querySelector<HTMLElement>('#update-held');
  const again = document.querySelector<HTMLButtonElement>('#update-again');
  if (note) {
    note.hidden = !update.held;
    note.textContent = update.held ? t('updateHeld').replace('{version}', update.held) : '';
  }
  if (again) again.hidden = !update.held;
};

// The earlier versions, newest first, the one just before this chosen; one
// this computer cannot install itself is offered from its release page.
const setUpRollback = (): void => {
  const dialog = document.querySelector<HTMLDialogElement>('#rollback-dialog');
  const list = document.querySelector<HTMLElement>('#rollback-list');
  const status = document.querySelector<HTMLElement>('#rollback-status');
  const confirm = document.querySelector<HTMLButtonElement>('#rollback-confirm');
  if (!dialog || !list || !status || !confirm) return;
  let choices: GlistRollbackChoice[] = [];
  const chosen = (): GlistRollbackChoice | undefined =>
    choices.find((choice) => choice.version === list.querySelector<HTMLInputElement>('input:checked')?.value);
  const label = (): void => {
    const choice = chosen();
    confirm.disabled = !choice;
    confirm.textContent = t(choice && !choice.installable ? 'rollbackOpenPage' : 'rollbackConfirm');
  };
  document.querySelector<HTMLButtonElement>('#rollback-open')?.addEventListener('click', () => {
    list.replaceChildren();
    status.textContent = t('rollbackLoading');
    status.classList.remove('dialog-error');
    confirm.disabled = true;
    confirm.textContent = t('rollbackConfirm');
    dialog.showModal();
    void window.glistAPI.rollbackChoices(previews()).then((found) => {
      choices = found;
      status.textContent = found.length ? '' : t('rollbackNone');
      list.replaceChildren(...found.map((choice, index) => {
        const row = document.createElement('label');
        row.className = 'rollback-choice';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'rollback-version';
        radio.value = choice.version;
        radio.checked = index === 0;
        radio.addEventListener('change', label);
        const version = document.createElement('span');
        version.className = 'rollback-version';
        version.textContent = choice.version;
        const facts = document.createElement('span');
        facts.className = 'rollback-facts';
        facts.textContent = [t(choice.preview ? 'rollbackPreview' : 'rollbackRelease'),
          choice.kept ? t('rollbackKept') : !choice.installable ? t('rollbackPageOnly') : ''].filter(Boolean).join(' · ');
        row.append(radio, version, facts);
        return row;
      }));
      label();
    }).catch((error: unknown) => {
      status.classList.add('dialog-error');
      status.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  document.querySelector<HTMLButtonElement>('#rollback-cancel')?.addEventListener('click', () => dialog.close());
  document.querySelector<HTMLFormElement>('#rollback-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const choice = chosen();
    if (!choice) return;
    dialog.close();
    if (choice.installable) asked = true;
    void window.glistAPI.rollBack(choice.version);
  });
  document.querySelector<HTMLButtonElement>('#update-again')?.addEventListener('click', () => {
    asked = true;
    void window.glistAPI.releaseHold(previews());
  });
};

const describe = (update: GlistUpdateState): void => {
  const version = update.version ?? '';
  const once = (key: string): boolean => {
    if (!asked && told.has(key)) return false;
    told.add(key);
    return true;
  };
  showHold(update);
  if (update.state === 'ready' && once(`ready ${version}`)) {
    notify({
      text: t(update.rollback ? 'rollbackReady' : 'updateReady').replace('{version}', version),
      actions: [{ label: t(update.rollback ? 'restartToRollBack' : 'restartToUpdate'), run: () => { void window.glistAPI.installUpdate(); } }],
    });
  } else if (update.state === 'downloading' && update.rollback && once(`rollback ${version}`)) {
    notify({ text: t('rollbackDownloading').replace('{version}', version) });
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
  void window.glistAPI.checkForUpdates(previews());
};

export const setUpUpdates = async (): Promise<void> => {
  window.glistAPI.onUpdateState(describe);
  const current = await window.glistAPI.updateState().catch((): GlistUpdateState => ({ state: 'unavailable' }));
  supported = current.state !== 'unavailable';
  const section = document.querySelector<HTMLElement>('#update-settings');
  const toggle = document.querySelector<HTMLInputElement>('#auto-update');
  const previewToggle = document.querySelector<HTMLInputElement>('#update-previews');
  const version = document.querySelector<HTMLElement>('#update-version');
  if (section) section.hidden = !supported;
  if (!supported) return;
  if (version) version.textContent = `Glist Studio ${current.current ?? ''}`;
  showHold(current);
  setUpRollback();
  if (toggle) {
    toggle.checked = automatic();
    toggle.addEventListener('change', () => {
      try { window.localStorage.setItem(storageKey, toggle.checked ? 'on' : 'off'); } catch { /* Storage may be unavailable. */ }
      if (toggle.checked) void window.glistAPI.checkForUpdates(previews());
    });
  }
  if (previewToggle) {
    previewToggle.checked = previews();
    previewToggle.addEventListener('change', () => {
      try { window.localStorage.setItem(previewsKey, previewToggle.checked ? 'on' : 'off'); } catch { /* Storage may be unavailable. */ }
      if (previewToggle.checked && automatic()) void window.glistAPI.checkForUpdates(true);
    });
  }
  const quietly = (): void => { if (automatic()) void window.glistAPI.checkForUpdates(previews()); };
  // A moment after starting, so opening the last project comes first.
  window.setTimeout(quietly, 10000);
  window.setInterval(quietly, checkEvery);
};
