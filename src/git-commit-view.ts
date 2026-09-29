import { showMenu } from './context-menu';
import { fileIconElement } from './file-icons';
import { stateLetter, stateText, type GitClient } from './git-client';
import { icon } from './icons';
import { t, type TranslationKey } from './localization';
import { notify } from './notifications';
import { baseName } from './paths';

// The Commit view beside the explorer, like JetBrains' Commit tool window: the
// changed files with a checkbox each, a message, and Commit. Clicking a file
// shows what changed in it as a diff in the editor area.

export interface CommitViewControls {
  branch: HTMLElement;
  banner: HTMLElement;
  changes: HTMLElement;
  box: HTMLElement;
  message: HTMLTextAreaElement;
  amend: HTMLInputElement;
  commit: HTMLButtonElement;
  commitAndPush: HTMLButtonElement;
  refresh: HTMLButtonElement;
  rollback: HTMLButtonElement;
  update: HTMLButtonElement;
  push: HTMLButtonElement;
}

export interface CommitViewHooks {
  projectRoot(): string | null;
  openDiff(change: GlistGitChange): void;
  openFile(filePath: string): void;
  // Opens a file with conflicts at the first of them.
  openConflict(filePath: string): void;
  deleteFile(filePath: string): Promise<void>;
  showHistory(filePath: string): void;
  push(): void;
  update(): void;
  branchMenu(anchor: HTMLElement): void;
  // Asks for a name and an email when git has none for commits.
  ensureIdentity(): Promise<boolean>;
}

type Group = 'conflicts' | 'changes' | 'unversioned';

const groupTitle: Record<Group, TranslationKey> = { conflicts: 'mergeConflicts', changes: 'changes', unversioned: 'unversioned' };

// The branch, or during a rebase the branch being rebased, or the commit HEAD is at.
export const branchName = (repository: GlistGitRepository): string => repository.branch
  ?? (repository.operation === 'rebase' && repository.operationSubject ? repository.operationSubject : null)
  ?? t('detached').replace('{hash}', repository.head?.slice(0, 7) ?? '');

const operationText: Record<GlistGitOperation, TranslationKey> = {
  merge: 'merging', rebase: 'rebasing', 'cherry-pick': 'cherryPicking', revert: 'reverting',
};

export class CommitView {
  // Changed files left out of the next commit, and unversioned ones put in it.
  private readonly excluded = new Set<string>();
  private readonly addedUnversioned = new Set<string>();
  private readonly collapsed = new Set<Group>();
  private selected: string | null = null;
  // The message being written before Amend put the last commit's in its place.
  private draft = '';
  // The merge whose message was put in the box, so it is put there once.
  private merging = '';
  private rows: HTMLElement[] = [];

  constructor(
    private readonly controls: CommitViewControls,
    private readonly client: GitClient,
    private readonly hooks: CommitViewHooks,
  ) {
    client.onStatus(() => this.render());
    controls.refresh.addEventListener('click', () => { void client.refresh(); });
    controls.rollback.addEventListener('click', () => { void this.rollback(this.included().filter((change) => change.state !== 'untracked')); });
    controls.update.addEventListener('click', () => hooks.update());
    controls.push.addEventListener('click', () => hooks.push());
    controls.commit.addEventListener('click', () => { void this.commit(false); });
    controls.commitAndPush.addEventListener('click', () => { void this.commit(true); });
    controls.message.addEventListener('input', () => { this.saveMessage(); this.updateButtons(); });
    controls.message.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this.commit(false); }
    });
    controls.amend.addEventListener('change', () => { void this.amendChanged(); });
    controls.changes.addEventListener('keydown', (event) => this.keydown(event));
  }

  focusMessage(): void {
    this.controls.message.focus();
  }

  render(): void {
    const status = this.client.status;
    const repository = this.client.repository;
    const { controls } = this;
    controls.box.hidden = !repository;
    [controls.rollback, controls.update, controls.push].forEach((button) => { button.disabled = !repository; });
    this.renderBranch(repository);
    this.renderBanner(repository);
    this.rows = [];
    if (!status?.version) { controls.changes.replaceChildren(this.empty(t(status ? 'gitMissing' : 'gitNoProject'))); return; }
    if (!this.hooks.projectRoot()) { controls.changes.replaceChildren(this.empty(t('gitNoProject'))); return; }
    if (!repository) {
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'empty-tree-action primary';
      create.append(icon('source-control'), t('createRepository'));
      create.addEventListener('click', () => { void this.client.run({ kind: 'init' }); });
      const hint = document.createElement('p');
      hint.className = 'empty-tree-description';
      hint.textContent = t('noRepositoryHint');
      const nodes: HTMLElement[] = [this.empty(t('noRepository')), hint, create];
      if (status.error) {
        const error = document.createElement('p');
        error.className = 'dialog-error';
        error.textContent = status.error;
        nodes.push(error);
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'commit-empty';
      wrapper.append(...nodes);
      controls.changes.replaceChildren(wrapper);
      return;
    }
    // Concluding a merge commits with git's message for it, unless one was written.
    const merge = repository.operation === 'merge' ? repository.operationSubject ?? '' : '';
    if (merge && merge !== this.merging && !controls.message.value.trim()) controls.message.value = merge;
    this.merging = merge;
    const known = new Set(repository.changes.map((change) => change.path));
    [this.excluded, this.addedUnversioned].forEach((set) => set.forEach((entry) => { if (!known.has(entry)) set.delete(entry); }));
    if (this.selected && !known.has(this.selected)) this.selected = null;
    const groups: Array<[Group, GlistGitChange[]]> = [
      ['conflicts', repository.changes.filter((change) => change.state === 'conflict')],
      ['changes', repository.changes.filter((change) => change.state !== 'conflict' && change.state !== 'untracked')],
      ['unversioned', repository.changes.filter((change) => change.state === 'untracked')],
    ];
    const nodes: HTMLElement[] = [];
    groups.forEach(([group, changes]) => {
      if (changes.length === 0) return;
      changes.sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' }));
      nodes.push(this.groupRow(group, changes));
      if (!this.collapsed.has(group)) changes.forEach((change) => nodes.push(this.changeRow(group, change)));
    });
    if (repository.changes.length === 0) nodes.push(this.empty(t('noChanges')));
    controls.changes.replaceChildren(...nodes);
    this.updateButtons();
  }

  // The files that go into the next commit.
  private included(): GlistGitChange[] {
    return (this.client.repository?.changes ?? []).filter((change) => (change.state === 'untracked'
      ? this.addedUnversioned.has(change.path) : change.state !== 'conflict' && !this.excluded.has(change.path)));
  }

  private isIncluded(change: GlistGitChange): boolean {
    return change.state === 'untracked' ? this.addedUnversioned.has(change.path) : !this.excluded.has(change.path);
  }

  private setIncluded(change: GlistGitChange, on: boolean): void {
    if (change.state === 'untracked') {
      if (on) this.addedUnversioned.add(change.path); else this.addedUnversioned.delete(change.path);
    } else if (on) this.excluded.delete(change.path);
    else this.excluded.add(change.path);
  }

  private updateButtons(): void {
    const repository = this.client.repository;
    const merging = Boolean(repository?.operation && repository.operation !== 'rebase');
    const hasFiles = this.included().length > 0 || merging || this.controls.amend.checked;
    const blocked = repository?.operation === 'rebase' || Boolean(repository?.changes.some((change) => change.state === 'conflict'));
    const ready = Boolean(repository) && hasFiles && !blocked && this.controls.message.value.trim().length > 0;
    this.controls.commit.disabled = !ready;
    this.controls.commitAndPush.disabled = !ready;
    this.controls.rollback.disabled = !repository || !this.included().some((change) => change.state !== 'untracked');
  }

  private empty(text: string): HTMLElement {
    const paragraph = document.createElement('p');
    paragraph.className = 'empty-tree-title commit-empty-text';
    paragraph.textContent = text;
    return paragraph;
  }

  private renderBranch(repository: GlistGitRepository | null): void {
    const { branch } = this.controls;
    branch.hidden = !repository;
    if (!repository) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'commit-branch-button';
    const name = document.createElement('span');
    name.textContent = branchName(repository);
    button.append(icon('git-branch'), name);
    if (repository.ahead) button.append(icon('arrow-up'), String(repository.ahead));
    if (repository.behind) button.append(icon('arrow-down'), String(repository.behind));
    button.title = t('aheadBehind').replace('{ahead}', String(repository.ahead)).replace('{behind}', String(repository.behind));
    button.addEventListener('click', (event) => { event.stopPropagation(); this.hooks.branchMenu(button); });
    const nodes: HTMLElement[] = [button];
    // A repository around the project, such as a folder of several projects.
    if (repository.aboveProject) {
      const location = document.createElement('span');
      location.className = 'commit-location';
      location.textContent = t('repositoryAt').replace('{location}', repository.location);
      location.title = repository.root;
      nodes.push(location);
    }
    branch.replaceChildren(...nodes);
  }

  private renderBanner(repository: GlistGitRepository | null): void {
    const { banner } = this.controls;
    banner.hidden = !repository?.operation;
    if (!repository?.operation) return;
    const title = document.createElement('p');
    title.className = 'commit-banner-title';
    title.textContent = t(operationText[repository.operation]).replace('{subject}', repository.operationSubject ?? '');
    const hint = document.createElement('p');
    hint.className = 'commit-banner-hint';
    hint.textContent = t(repository.operation === 'merge' ? 'resolveThenCommit' : 'resolveThenContinue');
    const buttons = document.createElement('div');
    buttons.className = 'commit-banner-actions';
    const button = (key: TranslationKey, action: 'abort' | 'continue' | 'skip', primary = false): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = t(key);
      if (primary) element.className = 'primary';
      element.addEventListener('click', () => { void this.client.run({ kind: action }); });
      return element;
    };
    if (repository.operation !== 'merge') buttons.append(button('continue', 'continue', true));
    if (repository.operation === 'rebase') buttons.append(button('skip', 'skip'));
    buttons.append(button('abort', 'abort'));
    banner.replaceChildren(title, hint, buttons);
  }

  private groupRow(group: Group, changes: GlistGitChange[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'change-group';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(!this.collapsed.has(group)));
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.classList.toggle('expanded', !this.collapsed.has(group));
    arrow.append(icon('chevron-right'));
    row.append(arrow);
    if (group !== 'conflicts') {
      const check = document.createElement('input');
      check.type = 'checkbox';
      const included = changes.filter((change) => this.isIncluded(change)).length;
      check.checked = included === changes.length;
      check.indeterminate = included > 0 && included < changes.length;
      check.addEventListener('click', (event) => event.stopPropagation());
      check.addEventListener('change', () => {
        changes.forEach((change) => this.setIncluded(change, check.checked));
        this.render();
      });
      row.append(check);
    }
    const label = document.createElement('span');
    label.className = 'change-group-label';
    label.textContent = t(groupTitle[group]);
    const count = document.createElement('span');
    count.className = 'change-count';
    count.textContent = String(changes.length);
    row.append(label, count);
    row.addEventListener('click', () => {
      if (this.collapsed.has(group)) this.collapsed.delete(group); else this.collapsed.add(group);
      this.render();
    });
    if (group === 'conflicts') {
      row.title = t('conflictHint');
    }
    return row;
  }

  private changeRow(group: Group, change: GlistGitChange): HTMLElement {
    const row = document.createElement('div');
    row.className = `change-row git-${change.state}`;
    row.tabIndex = this.selected === change.path || (!this.selected && this.rows.length === 0) ? 0 : -1;
    row.dataset.path = change.path;
    row.setAttribute('role', 'treeitem');
    row.classList.toggle('selected', this.selected === change.path);
    const root = this.hooks.projectRoot() ?? '';
    const relative = change.path.startsWith(root) ? change.path.slice(root.length + 1) : change.path;
    const directory = relative.slice(0, Math.max(0, relative.length - baseName(relative).length - 1));
    row.title = `${relative}\n${t(stateText[change.state])}${change.from ? `: ${change.from.startsWith(root) ? change.from.slice(root.length + 1) : change.from}` : ''}`;
    if (group !== 'conflicts') {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.tabIndex = -1;
      check.checked = this.isIncluded(change);
      check.addEventListener('click', (event) => event.stopPropagation());
      check.addEventListener('change', () => { this.setIncluded(change, check.checked); this.render(); });
      row.append(check);
    }
    const name = document.createElement('span');
    name.className = 'change-name';
    name.textContent = baseName(change.path);
    const folder = document.createElement('span');
    folder.className = 'change-dir';
    folder.textContent = directory;
    row.append(fileIconElement(baseName(change.path)), name, folder);
    if (group === 'conflicts') {
      const side = (key: TranslationKey, value: 'mine' | 'theirs'): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'change-side';
        button.textContent = t(key);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.resolve(change.path, value);
        });
        return button;
      };
      // On a line of their own, so the name keeps its room.
      const sides = document.createElement('div');
      sides.className = 'change-sides';
      sides.append(side('keepMine', 'mine'), side('takeTheirs', 'theirs'));
      row.classList.add('conflict-row');
      row.append(sides);
    } else {
      const letter = document.createElement('span');
      letter.className = 'change-state';
      letter.textContent = stateLetter[change.state];
      row.append(letter);
    }
    row.addEventListener('click', () => {
      this.select(change.path);
      if (group === 'conflicts') this.hooks.openConflict(change.path);
      else this.hooks.openDiff(change);
    });
    row.addEventListener('dblclick', () => { if (change.state !== 'deleted') this.hooks.openFile(change.path); });
    row.addEventListener('contextmenu', (event) => { this.select(change.path); this.menu(event, group, change); });
    this.rows.push(row);
    return row;
  }

  private select(filePath: string): void {
    this.selected = filePath;
    this.rows.forEach((row) => {
      const active = row.dataset.path === filePath;
      row.classList.toggle('selected', active);
      row.tabIndex = active ? 0 : -1;
      if (active) row.focus({ preventScroll: true });
    });
  }

  private menu(event: MouseEvent, group: Group, change: GlistGitChange): void {
    if (group === 'conflicts') {
      showMenu(event, [
        { label: t('openFile'), run: () => this.hooks.openConflict(change.path) },
        'separator',
        { label: t('keepMine'), run: () => { void this.resolve(change.path, 'mine'); } },
        { label: t('takeTheirs'), run: () => { void this.resolve(change.path, 'theirs'); } },
        { label: t('markResolved'), run: () => { void this.client.run({ kind: 'mark-resolved', paths: [change.path] }); } },
      ]);
      return;
    }
    const untracked = change.state === 'untracked';
    showMenu(event, [
      { label: t('showDiff'), run: () => this.hooks.openDiff(change) },
      { label: t('openFile'), run: () => this.hooks.openFile(change.path), disabled: change.state === 'deleted' },
      ...(untracked ? [] : [{ label: t('showHistory'), run: () => this.hooks.showHistory(change.from ?? change.path) }]),
      'separator',
      ...(untracked
        ? [
          { label: t('addToGitignore'), run: () => { void this.client.run({ kind: 'ignore', paths: [change.path] }); } },
          { label: t('delete'), danger: true, run: () => { void this.deleteUnversioned(change); } },
        ]
        : [{ label: `${t('rollback')}...`, danger: true, run: () => { void this.rollback([change]); } }]),
    ]);
  }

  // A whole file in one click is easy to do by mistake, so it can be taken back.
  private async resolve(filePath: string, side: 'mine' | 'theirs'): Promise<void> {
    const result = await this.client.run({ kind: 'resolve', path: filePath, side });
    if (!result.success) return;
    notify({
      text: t(side === 'mine' ? 'keptMine' : 'tookTheirs').replace('{name}', baseName(filePath)),
      kind: 'success',
      actions: [{ label: t('undo'), run: () => { void this.client.run({ kind: 'unresolve', path: filePath }); } }],
    });
  }

  private async deleteUnversioned(change: GlistGitChange): Promise<void> {
    if (!window.confirm(`“${baseName(change.path)}”: ${t('confirmDeleteFile')}`)) return;
    await this.hooks.deleteFile(change.path);
    await this.client.refresh();
  }

  private async rollback(changes: GlistGitChange[]): Promise<void> {
    if (changes.length === 0) return;
    const question = changes.length === 1
      ? t('confirmRollbackOne').replace('{name}', baseName(changes[0].path))
      : t('confirmRollback').replace('{count}', String(changes.length));
    if (!window.confirm(question)) return;
    await this.client.run({ kind: 'rollback', paths: changes.map((change) => change.path) });
  }

  private keydown(event: KeyboardEvent): void {
    const index = this.rows.findIndex((row) => row.dataset.path === this.selected);
    const change = this.client.repository?.changes.find((entry) => entry.path === this.selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = this.rows[Math.min(this.rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next?.dataset.path) this.select(next.dataset.path);
    } else if (event.key === ' ' && change && change.state !== 'conflict') {
      event.preventDefault();
      this.setIncluded(change, !this.isIncluded(change));
      this.render();
      this.select(change.path);
    } else if (event.key === 'Enter' && change) {
      event.preventDefault();
      if (change.state === 'conflict') this.hooks.openConflict(change.path); else this.hooks.openDiff(change);
    }
  }

  private messageKey(): string | null {
    const root = this.client.repository?.root;
    return root ? `glist-studio-commit-message:${root}` : null;
  }

  private saveMessage(): void {
    const key = this.messageKey();
    if (!key || this.controls.amend.checked) return;
    try {
      if (this.controls.message.value) window.localStorage.setItem(key, this.controls.message.value);
      else window.localStorage.removeItem(key);
    } catch { /* Storage may be unavailable. */ }
  }

  // The message written for this repository before, when a project opens.
  restoreMessage(): void {
    const key = this.messageKey();
    this.controls.amend.checked = false;
    try { this.controls.message.value = (key && window.localStorage.getItem(key)) || ''; } catch { this.controls.message.value = ''; }
    this.updateButtons();
  }

  private async amendChanged(): Promise<void> {
    const { message, amend } = this.controls;
    if (amend.checked) {
      this.draft = message.value;
      if (!message.value.trim()) message.value = await window.glistAPI.gitLastMessage().catch(() => '');
    } else {
      message.value = this.draft;
      this.draft = '';
    }
    this.updateButtons();
  }

  async commit(andPush: boolean): Promise<void> {
    const repository = this.client.repository;
    const message = this.controls.message.value.trim();
    if (!repository || !message) { this.controls.message.focus(); return; }
    if (!(await this.hooks.ensureIdentity())) return;
    const paths = this.included().flatMap((change) => (change.from ? [change.path, change.from] : [change.path]));
    const amend = this.controls.amend.checked;
    const result = await this.client.run({ kind: 'commit', message, paths, amend }, { busy: 'committing' });
    if (!result.success) return;
    notify({ text: t('committedMessage').replace('{subject}', message.split('\n')[0]), kind: 'success' });
    this.controls.message.value = '';
    this.controls.amend.checked = false;
    this.draft = '';
    this.saveMessage();
    this.updateButtons();
    if (andPush) this.hooks.push();
  }
}
