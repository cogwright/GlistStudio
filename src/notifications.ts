import { copyReport, type ReportError } from './debug-report';
import { icon } from './icons';
import { t } from './localization';

// Balloons in the corner of the window, for what finished in the background:
// "Pushed to origin", or why it could not be done, with buttons to act on it.

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  text: string;
  kind?: 'info' | 'success' | 'error';
  // A second line in smaller type.
  detail?: string;
  // What failed, for Copy Details: an Error's stack goes into the report.
  error?: unknown;
  actions?: NoticeAction[];
}

const host = document.createElement('div');
host.className = 'notices';
host.setAttribute('role', 'status');
host.setAttribute('aria-live', 'polite');
document.body.append(host);

// Copy Details on an error notice puts a report on the clipboard
// (debug-report.ts) and says Copied for a moment; the notice stays.
const copyButton = (error: ReportError): HTMLButtonElement => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'notice-copy';
  button.textContent = t('copyDetails');
  let timer = 0;
  button.addEventListener('click', () => {
    void copyReport(error).then((copied) => t(copied ? 'copied' : 'copyDetailsFailed'), () => t('copyDetailsFailed')).then((label) => {
      button.textContent = label;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { button.textContent = t('copyDetails'); }, 2000);
    });
  });
  return button;
};

export const notify = ({ text, kind = 'info', detail, error, actions = [] }: Notice): void => {
  const notice = document.createElement('div');
  notice.className = `notice ${kind}`;
  const mark = document.createElement('span');
  mark.className = 'notice-icon';
  mark.append(icon(kind === 'error' ? 'error' : kind === 'success' ? 'check' : 'info'));
  const body = document.createElement('div');
  body.className = 'notice-body';
  const title = document.createElement('p');
  title.className = 'notice-text';
  title.textContent = text;
  body.append(title);
  if (detail) {
    const more = document.createElement('p');
    more.className = 'notice-detail';
    more.textContent = detail;
    body.append(more);
  }
  const dismiss = (): void => notice.remove();
  if (actions.length > 0 || kind === 'error') {
    const buttons = document.createElement('div');
    buttons.className = 'notice-actions';
    actions.forEach((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => { dismiss(); action.run(); });
      buttons.append(button);
    });
    if (kind === 'error') buttons.append(copyButton({ text, detail, error }));
    body.append(buttons);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notice-close';
  close.title = t('close');
  close.setAttribute('aria-label', t('close'));
  close.append(icon('close'));
  close.addEventListener('click', dismiss);
  notice.append(mark, body, close);
  host.append(notice);
  // Failures and questions stay until they are closed.
  if (kind !== 'error' && actions.length === 0) {
    let timer = window.setTimeout(dismiss, 6000);
    notice.addEventListener('pointerenter', () => window.clearTimeout(timer));
    notice.addEventListener('pointerleave', () => { timer = window.setTimeout(dismiss, 3000); });
  }
  // Only the latest few are kept.
  while (host.children.length > 4) host.firstElementChild?.remove();
};
