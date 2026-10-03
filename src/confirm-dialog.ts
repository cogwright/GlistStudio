import { t } from './localization';

// Yes-or-no questions, asked in a dialog of the studio's own. window.confirm
// opens the system's box, and once that closes, Chromium can be left thinking
// the window has no focus: typing then reaches no text box until the window is
// switched away from and back. Electron 44.5 fixed that on Windows only, and
// advises against window.confirm (electron/electron#51760). One question is
// asked at a time; another waits for its answer. Its buttons say OK and Cancel
// unless told what yes and no do.
let asking: Promise<unknown> = Promise.resolve();

export const confirmDialog = (message: string, labels?: { yes: string; no: string }): Promise<boolean> => {
  const answer = asking.then((): Promise<boolean> => ask(message, labels));
  asking = answer.catch((): undefined => undefined);
  return answer;
};

// OK answers yes, as Enter does, the button having the keys; Cancel and Escape answer no.
const ask = (message: string, labels?: { yes: string; no: string }): Promise<boolean> => new Promise((resolve) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog confirm-dialog';
  const text = document.createElement('p');
  text.className = 'confirm-message';
  text.textContent = message;
  const button = (label: string, className = ''): HTMLButtonElement => Object.assign(document.createElement('button'), { type: 'button', className, textContent: label });
  const cancel = button(labels?.no ?? t('cancel'));
  const ok = button(labels?.yes ?? t('ok'), 'primary');
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.append(cancel, ok);
  dialog.append(text, actions);
  let answered = false;
  const answer = (yes: boolean): void => {
    if (answered) return;
    answered = true;
    dialog.close();
    dialog.remove();
    resolve(yes);
  };
  cancel.addEventListener('click', () => answer(false));
  ok.addEventListener('click', () => answer(true));
  dialog.addEventListener('close', () => answer(false));
  document.body.append(dialog);
  dialog.showModal();
  ok.focus();
});
