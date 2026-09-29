import { t } from './localization';
import { relativeTime } from './time';

// Dialogs for Git: a small form each, and the Push and Clone dialogs.

export type Field =
  | { kind: 'text'; key: string; label: string; value?: string; placeholder?: string; required?: boolean; autofocus?: boolean }
  | { kind: 'checkbox'; key: string; label: string; value?: boolean; hint?: string }
  | { kind: 'choice'; key: string; label?: string; options: Array<{ value: string; label: string }>; value: string };

export type FormValues = Record<string, string | boolean>;

export interface FormOptions {
  title: string;
  hint?: string;
  fields: Field[];
  submit: string;
  danger?: boolean;
  // Something shown between the hint and the fields, such as a list of commits.
  body?: HTMLElement;
  // Checked before the dialog closes; a message keeps it open with that error.
  validate?: (values: FormValues) => Promise<string | null> | string | null;
  // Shown while validate runs, with a way to follow its progress.
  busy?: { text: string; follow?: (update: (text: string) => void) => () => void };
  // Told when a text field changes, to fill in another from it.
  changed?: (key: string, value: string, set: (key: string, value: string) => void) => void;
}

let counter = 0;

export const formDialog = (options: FormOptions): Promise<FormValues | null> => new Promise((resolve) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'studio-dialog git-dialog';
  const form = document.createElement('form');
  form.method = 'dialog';
  const title = document.createElement('h2');
  title.textContent = options.title;
  form.append(title);
  if (options.hint) {
    const hint = document.createElement('p');
    hint.className = 'dialog-hint git-dialog-hint';
    hint.textContent = options.hint;
    form.append(hint);
  }
  if (options.body) form.append(options.body);
  const read: Array<() => [string, string | boolean]> = [];
  const textInputs = new Map<string, HTMLInputElement>();
  const set = (key: string, value: string): void => { const input = textInputs.get(key); if (input) input.value = value; };
  let focus: HTMLElement | null = null;
  options.fields.forEach((field) => {
    counter += 1;
    const id = `git-field-${counter}`;
    if (field.kind === 'text') {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = field.label;
      const input = document.createElement('input');
      input.id = id;
      input.type = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = field.value ?? '';
      input.placeholder = field.placeholder ?? '';
      input.required = Boolean(field.required);
      form.append(label, input);
      textInputs.set(field.key, input);
      input.addEventListener('input', () => options.changed?.(field.key, input.value, set));
      if (field.autofocus || !focus) focus = input;
      read.push(() => [field.key, input.value.trim()]);
    } else if (field.kind === 'checkbox') {
      const label = document.createElement('label');
      label.className = 'checkbox-row';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(field.value);
      const text = document.createElement('span');
      text.textContent = field.label;
      label.append(input, text);
      form.append(label);
      if (field.hint) {
        const hint = document.createElement('p');
        hint.className = 'dialog-hint checkbox-hint';
        hint.textContent = field.hint;
        form.append(hint);
      }
      read.push(() => [field.key, input.checked]);
    } else {
      const group = document.createElement('fieldset');
      group.className = 'git-choice';
      if (field.label) {
        const legend = document.createElement('legend');
        legend.textContent = field.label;
        group.append(legend);
      }
      const inputs = field.options.map((option) => {
        const label = document.createElement('label');
        label.className = 'checkbox-row';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = id;
        input.value = option.value;
        input.checked = option.value === field.value;
        const text = document.createElement('span');
        text.textContent = option.label;
        label.append(input, text);
        group.append(label);
        return input;
      });
      form.append(group);
      read.push(() => [field.key, inputs.find((input) => input.checked)?.value ?? field.value]);
    }
  });
  const error = document.createElement('p');
  error.className = 'dialog-error';
  error.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('cancel');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = options.danger ? 'primary danger' : 'primary';
  submit.textContent = options.submit;
  actions.append(cancel, submit);
  form.append(error, actions);
  dialog.append(form);
  document.body.append(dialog);
  let settled = false;
  const finish = (values: FormValues | null): void => {
    if (settled) return;
    settled = true;
    dialog.close();
    dialog.remove();
    resolve(values);
  };
  cancel.addEventListener('click', () => finish(null));
  dialog.addEventListener('close', () => finish(null));
  let working = false;
  // A running validation cannot be walked away from.
  dialog.addEventListener('cancel', (event) => { if (working) event.preventDefault(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (working) return;
    const values = Object.fromEntries(read.map((reader) => reader()));
    working = true;
    submit.disabled = true;
    cancel.disabled = true;
    error.classList.add('busy');
    error.textContent = options.busy?.text ?? '';
    const stop = options.busy?.follow?.((text) => { error.textContent = text; });
    let problem: string | null = null;
    try { problem = (await options.validate?.(values)) ?? null; } finally {
      stop?.();
      working = false;
      submit.disabled = false;
      cancel.disabled = false;
      error.classList.remove('busy');
      error.textContent = '';
    }
    if (problem) { error.textContent = problem; return; }
    finish(values);
  });
  dialog.showModal();
  (focus as HTMLElement | null)?.focus();
  if (focus instanceof HTMLInputElement) focus.select();
});

// Git's name and email for commits, set for every project on this computer.
export const identityDialog = async (current: GlistGitIdentity): Promise<GlistGitIdentity | null> => {
  const values = await formDialog({
    title: t('identityTitle'),
    hint: t('identityHint'),
    submit: t('saveButton'),
    fields: [
      { kind: 'text', key: 'name', label: t('gitName'), value: current.name || current.suggestedName, required: true },
      { kind: 'text', key: 'email', label: t('gitEmail'), value: current.email, required: true },
    ],
  });
  return values ? { name: String(values.name), email: String(values.email) } : null;
};

// What Push would send and where, with the commits listed.
export const pushDialog = async (outgoing: Awaited<ReturnType<Window['glistAPI']['gitOutgoing']>>, upstream: string | null):
  Promise<{ remote: string; tags: boolean; force: boolean } | null> => {
  const body = document.createElement('div');
  body.className = 'push-summary';
  const target = document.createElement('p');
  target.className = 'push-target';
  target.textContent = t('pushTarget').replace('{branch}', outgoing.branch ?? '').replace('{remote}', outgoing.remote ?? '');
  body.append(target);
  if (!upstream) {
    const fresh = document.createElement('p');
    fresh.className = 'dialog-hint';
    fresh.textContent = t('pushNewBranch');
    body.append(fresh);
  }
  const list = document.createElement('ul');
  list.className = 'push-commits';
  outgoing.commits.forEach((commit) => {
    const item = document.createElement('li');
    const hash = document.createElement('span');
    hash.className = 'push-hash';
    hash.textContent = commit.short;
    const subject = document.createElement('span');
    subject.className = 'push-subject';
    subject.textContent = commit.subject;
    const when = document.createElement('span');
    when.className = 'push-time';
    when.textContent = relativeTime(commit.date * 1000);
    item.append(hash, subject, when);
    list.append(item);
  });
  if (outgoing.commits.length === 0) {
    const nothing = document.createElement('li');
    nothing.className = 'push-nothing';
    nothing.textContent = t('pushNothing');
    list.append(nothing);
  }
  body.append(list);
  const fields: Field[] = [];
  if (outgoing.remotes.length > 1) {
    fields.push({
      kind: 'choice', key: 'remote', label: t('remoteLabel'), value: outgoing.remote ?? outgoing.remotes[0],
      options: outgoing.remotes.map((remote) => ({ value: remote, label: remote })),
    });
  }
  fields.push({ kind: 'checkbox', key: 'tags', label: t('pushTags') });
  fields.push({ kind: 'checkbox', key: 'force', label: t('forcePush'), hint: t('forcePushHint') });
  const values = await formDialog({ title: t('pushCommits'), fields, submit: t('pushButton'), body });
  if (!values) return null;
  return { remote: String(values.remote ?? outgoing.remote), tags: Boolean(values.tags), force: Boolean(values.force) };
};

// The folder name a repository's address suggests: MyGame for .../MyGame.git.
export const folderForUrl = (url: string): string => url.trim().replace(/[\\/]+$/, '').replace(/\.git$/, '')
  .split(/[\\/:]/).pop()?.replace(/[^A-Za-z0-9._-]/g, '') ?? '';

// Clone: an address and a folder name; the repository goes into the projects
// folder and opens as a project.
export const cloneDialog = async (
  location: string,
  follow: (update: (text: string) => void) => () => void,
): Promise<string | null> => {
  let root: string | null = null;
  const values = await formDialog({
    title: t('cloneTitle'),
    hint: t('cloneLocation').replace('{location}', location),
    submit: t('cloneButton'),
    fields: [
      { kind: 'text', key: 'url', label: t('cloneUrl'), placeholder: 'https://github.com/GlistEngine/GlistApp.git', required: true },
      { kind: 'text', key: 'folder', label: t('folderName'), required: true },
    ],
    changed: (key, value, fill) => { if (key === 'url') fill('folder', folderForUrl(value)); },
    busy: { text: t('cloning'), follow },
    validate: async (entered) => {
      const result = await window.glistAPI.gitClone(String(entered.url), String(entered.folder));
      if (!result.success || !result.root) return result.message;
      root = result.root;
      return null;
    },
  });
  return values ? root : null;
};
