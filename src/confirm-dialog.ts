import { t } from './localization';

// Yes-or-no questions, asked in a dialog of the studio's own. window.confirm
// opens the system's box, and once that closes, Chromium can be left thinking
// the window has no focus: typing then reaches no text box until the window is
// switched away from and back. Electron 44.5 fixed that on Windows only, and
// advises against window.confirm (electron/electron#51760). One question is
// asked at a time; another waits for its answer.
let asking: Promise<unknown> = Promise.resolve();

export interface Choice<T extends string> {
  value: T;
  label: string;
  // Has the keys, so Enter chooses it.
  primary?: boolean;
}

// A question with Cancel first and choices of its own after it: the one
// chosen, or null for Cancel and Escape, which leave everything as it was.
export const choiceDialog = <T extends string>(message: string, choices: Array<Choice<T>>): Promise<T | null> => {
  const answer = asking.then((): Promise<T | null> => ask(message, choices));
  asking = answer.catch((): undefined => undefined);
  return answer;
};

// OK answers yes, as Enter does, the button having the keys; Cancel and Escape answer no.
export const confirmDialog = (message: string): Promise<boolean> =>
  choiceDialog(message, [{ value: 'yes', label: t('ok'), primary: true }]).then((chosen) => chosen === 'yes');

const ask = <T extends string>(message: string, choices: Array<Choice<T>>): Promise<T | null> => new Promise((resolve) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog confirm-dialog';
  const text = document.createElement('p');
  text.className = 'confirm-message';
  text.textContent = message;
  const button = (label: string, className = ''): HTMLButtonElement => Object.assign(document.createElement('button'), { type: 'button', className, textContent: label });
  const cancel = button(t('cancel'));
  const chosen = choices.map((choice) => button(choice.label, choice.primary ? 'primary' : ''));
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.append(cancel, ...chosen);
  dialog.append(text, actions);
  let answered = false;
  const answer = (value: T | null): void => {
    if (answered) return;
    answered = true;
    dialog.close();
    dialog.remove();
    resolve(value);
  };
  cancel.addEventListener('click', () => answer(null));
  chosen.forEach((each, index) => each.addEventListener('click', () => answer(choices[index].value)));
  dialog.addEventListener('close', () => answer(null));
  document.body.append(dialog);
  dialog.showModal();
  (chosen[choices.findIndex((choice) => choice.primary)] ?? cancel).focus();
});
