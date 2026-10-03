import { t } from './localization';

// Text put on the clipboard. In the app the main process writes it, with
// Electron's own clipboard: the browser's needs the window to have the focus
// when the text arrives, which a copy made after a wait, such as Copy Details
// asking the backend first, may no longer have, and irrl saw it fail on Linux.
// The browser build has only the browser's.
export const copyText = async (text: string): Promise<void> => {
  if (window.glistFiles) await window.glistAPI.copyText(text);
  else await navigator.clipboard.writeText(text);
};

// Text the clipboard would not take, in a box to copy by hand, chosen already.
export const showTextToCopy = (text: string): void => {
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog copy-dialog';
  const message = document.createElement('p');
  message.className = 'confirm-message';
  message.textContent = t('copyByHand');
  const box = document.createElement('textarea');
  box.className = 'copy-text';
  box.readOnly = true;
  box.spellcheck = false;
  box.value = text;
  const close = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: t('close') });
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  actions.append(close);
  dialog.append(message, box, actions);
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  box.focus();
  box.select();
  box.scrollTop = 0;
};
