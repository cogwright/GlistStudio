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

// The project's files by what happened to them, and the engine's and plugins' as 'shared'.
type Group = 'conflicts' | 'changes' | 'unversioned' | 'shared';

const byPath = (left: GlistGitChange, right: GlistGitChange): number =>
  left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' });

const kindText: Record<GlistGitRepository['kind'], TranslationKey> = { project: 'kindProject', engine: 'kindEngine', plugin: 'kindPlugin' };

const groupTitle: Record<Exclude<Group, 'shared'>, TranslationKey> = { conflicts: 'mergeConflicts', changes: 'changes', unversioned: 'unversioned' };

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
  // The engine's and plugins' files are shared by every project, so none go into a
  // commit until chosen, and their groups start closed.
  private readonly includedShared = new Set<string>();
  private readonly openShared = new Set<string>();
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
    controls.rollback.addEventListener('click', () => { void this.rollbackChosen(); });
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
    const sharedChanges = this.client.dependencies.some((dependency) => dependency.changes.length > 0);
    controls.box.hidden = !repository && !sharedChanges;
    controls.update.disabled = !repository;
    controls.push.disabled = !repository && this.client.dependencies.length === 0;
    this.renderBranch(repository);
    this.renderBanners(repository);
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
      controls.changes.replaceChildren(wrapper, ...this.sharedNodes());
      this.updateButtons();
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
      changes.sort(byPath);
      nodes.push(this.groupRow(t(groupTitle[group as Exclude<Group, 'shared'>]), changes, {
        open: !this.collapsed.has(group),
        toggle: () => { if (this.collapsed.has(group)) this.collapsed.delete(group); else this.collapsed.add(group); },
        checkbox: group !== 'conflicts',
        title: group === 'conflicts' ? t('conflictHint') : undefined,
      }));
      if (!this.collapsed.has(group)) changes.forEach((change) => nodes.push(this.changeRow(group, change)));
    });
    if (repository.changes.length === 0) nodes.push(this.empty(t('noChanges')));
    controls.changes.replaceChildren(...nodes, ...this.sharedNodes());
    this.updateButtons();
  }

  // The engine and plugins with changes, each in a group of its own.
  private sharedNodes(): HTMLElement[] {
    const known = new Set(this.client.dependencies.flatMap((dependency) => dependency.changes.map((change) => change.path)));
    this.includedShared.forEach((entry) => { if (!known.has(entry)) this.includedShared.delete(entry); });
    return this.client.dependencies.filter((dependency) => dependency.changes.length > 0).flatMap((dependency) => {
      const changes = [...dependency.changes].sort(byPath);
      // Conflicts there need resolving, so their group opens by itself.
      const open = this.openShared.has(dependency.folder) || changes.some((change) => change.state === 'conflict');
      const header = this.groupRow(dependency.name, changes, {
        open,
        toggle: () => { if (open) this.openShared.delete(dependency.folder); else this.openShared.add(dependency.folder); },
        checkbox: true,
        title: t('sharedChanges').replace('{name}', dependency.name),
        kind: t(kindText[dependency.kind]),
      });
      return [header, ...(open ? changes.map((change) => this.changeRow('shared', change, dependency)) : [])];
    });
  }

  // The engine's and plugins' files chosen for the next commit, by repository.
  private sharedIncluded(): Array<[GlistGitRepository, GlistGitChange[]]> {
    return this.client.dependencies
      .map((dependency): [GlistGitRepository, GlistGitChange[]] => [dependency, dependency.changes.filter((change) => this.includedShared.has(change.path))])
      .filter(([, changes]) => changes.length > 0);
  }

  private isShared(change: GlistGitChange): boolean {
    return this.client.rootOf(change.path) !== undefined;
  }

  // The files that go into the next commit.
  private included(): GlistGitChange[] {
    return (this.client.repository?.changes ?? []).filter((change) => (change.state === 'untracked'
      ? this.addedUnversioned.has(change.path) : change.state !== 'conflict' && !this.excluded.has(change.path)));
  }

  private isIncluded(change: GlistGitChange): boolean {
    if (change.state === 'conflict') return false;
    if (this.isShared(change)) return this.includedShared.has(change.path);
    return change.state === 'untracked' ? this.addedUnversioned.has(change.path) : !this.excluded.has(change.path);
  }

  private setIncluded(change: GlistGitChange, on: boolean): void {
    // A conflict is resolved first; committing it now would keep its markers.
    if (change.state === 'conflict') return;
    if (this.isShared(change)) {
      if (on) this.includedShared.add(change.path); else this.includedShared.delete(change.path);
    } else if (change.state === 'untracked') {
      if (on) this.addedUnversioned.add(change.path); else this.addedUnversioned.delete(change.path);
    } else if (on) this.excluded.delete(change.path);
    else this.excluded.add(change.path);
  }

  private updateButtons(): void {
    const repository = this.client.repository;
    // A commit already pushed is not amended while protection is on (Settings > Git).
    const pushed = Boolean(repository?.headPushed);
    this.controls.amend.disabled = pushed;
    this.controls.amend.closest('label')?.setAttribute('title', pushed ? t('amendLocked') : '');
    if (pushed && this.controls.amend.checked) {
      this.controls.amend.checked = false;
      void this.amendChanged();
      return;
    }
    const merging = Boolean(repository?.operation && repository.operation !== 'rebase');
    const shared = this.sharedIncluded();
    const hasFiles = this.included().length > 0 || shared.length > 0 || merging || this.controls.amend.checked;
    const blocked = repository?.operation === 'rebase' || Boolean(repository?.changes.some((change) => change.state === 'conflict'));
    const ready = Boolean(repository || shared.length > 0) && hasFiles && !blocked && this.controls.message.value.trim().length > 0;
    this.controls.commit.disabled = !ready;
    this.controls.commitAndPush.disabled = !ready;
    this.controls.rollback.disabled = ![...this.included(), ...shared.flatMap(([, changes]) => changes)].some((change) => change.state !== 'untracked');
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

  // A merge, rebase, cherry-pick or revert that stopped, in the project or in the
  // engine or a plugin, each with what finishes it or takes it back.
  private renderBanners(repository: GlistGitRepository | null): void {
    const { banner } = this.controls;
    const stopped = [...(repository?.operation ? [repository] : []), ...this.client.dependencies.filter((dependency) => dependency.operation)];
    banner.hidden = stopped.length === 0;
    banner.replaceChildren(...stopped.map((entry) => this.bannerFor(entry)));
  }

  private bannerFor(repository: GlistGitRepository): HTMLElement {
    const operation = repository.operation as GlistGitOperation;
    const root = repository.kind === 'project' ? undefined : repository.folder;
    const item = document.createElement('div');
    item.className = 'commit-banner-item';
    const title = document.createElement('p');
    title.className = 'commit-banner-title';
    const what = t(operationText[operation]).replace('{subject}', repository.operationSubject ?? '');
    title.textContent = root === undefined ? what : `${repository.name}: ${what}`;
    const hint = document.createElement('p');
    hint.className = 'commit-banner-hint';
    hint.textContent = t(operation === 'merge' ? 'resolveThenCommit' : 'resolveThenContinue');
    const buttons = document.createElement('div');
    buttons.className = 'commit-banner-actions';
    const button = (key: TranslationKey, run: () => void, primary = false): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = t(key);
      if (primary) element.className = 'primary';
      element.addEventListener('click', run);
      return element;
    };
    const step = (action: 'abort' | 'continue' | 'skip') => () => { void this.client.run({ kind: action }, { root }); };
    // The project's merge is committed with the message box; an engine's or plugin's with git's own message.
    if (operation === 'merge' && root !== undefined) {
      buttons.append(button('commit', () => {
        void this.client.run({ kind: 'commit', message: repository.operationSubject || 'Merge', paths: [], amend: false }, { root, busy: 'committing' });
      }, true));
    }
    if (operation !== 'merge') buttons.append(button('continue', step('continue'), true));
    if (operation === 'rebase') buttons.append(button('skip', step('skip')));
    buttons.append(button('abort', step('abort')));
    item.append(title, hint, buttons);
    return item;
  }

  private groupRow(label: string, changes: GlistGitChange[], options: {
    open: boolean; toggle: () => void; checkbox: boolean; title?: string; kind?: string;
  }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'change-group';
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-expanded', String(options.open));
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.classList.toggle('expanded', options.open);
    arrow.append(icon('chevron-right'));
    row.append(arrow);
    if (options.checkbox) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      const eligible = changes.filter((change) => change.state !== 'conflict');
      const included = eligible.filter((change) => this.isIncluded(change)).length;
      check.checked = eligible.length > 0 && included === eligible.length;
      check.indeterminate = included > 0 && included < eligible.length;
      check.addEventListener('click', (event) => event.stopPropagation());
      check.addEventListener('change', () => {
        changes.forEach((change) => this.setIncluded(change, check.checked));
        this.render();
      });
      row.append(check);
    }
    const name = document.createElement('span');
    name.className = 'change-group-label';
    name.textContent = label;
    row.append(name);
    if (options.kind) {
      const kind = document.createElement('span');
      kind.className = 'change-group-kind';
      kind.textContent = options.kind;
      row.append(kind);
    }
    const count = document.createElement('span');
    count.className = 'change-count';
    count.textContent = String(changes.length);
    row.append(count);
    row.addEventListener('click', () => { options.toggle(); this.render(); });
    if (options.title) row.title = options.title;
    return row;
  }

  // A file of the project, or of an engine or plugin with its repository.
  private changeRow(group: Group, change: GlistGitChange, shared?: GlistGitRepository): HTMLElement {
    const row = document.createElement('div');
    row.className = `change-row git-${change.state}`;
    row.tabIndex = this.selected === change.path || (!this.selected && this.rows.length === 0) ? 0 : -1;
    row.dataset.path = change.path;
    row.setAttribute('role', 'treeitem');
    row.classList.toggle('selected', this.selected === change.path);
    const root = shared?.folder ?? this.hooks.projectRoot() ?? '';
    const relative = change.path.startsWith(root) ? change.path.slice(root.length + 1) : change.path;
    const directory = relative.slice(0, Math.max(0, relative.length - baseName(relative).length - 1));
    row.title = `${relative}\n${t(stateText[change.state])}${change.from ? `: ${change.from.startsWith(root) ? change.from.slice(root.length + 1) : change.from}` : ''}`;
    const conflict = change.state === 'conflict';
    if (!conflict) {
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
    if (conflict) {
      const side = (key: TranslationKey, value: 'mine' | 'theirs'): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'change-side';
        button.textContent = t(key);
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.resolve(change.path, value, shared?.folder);
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
      if (conflict) this.hooks.openConflict(change.path);
      else this.hooks.openDiff(change);
    });
    row.addEventListener('dblclick', () => { if (change.state !== 'deleted') this.hooks.openFile(change.path); });
    row.addEventListener('contextmenu', (event) => { this.select(change.path); this.menu(event, group, change, shared?.folder); });
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

  private menu(event: MouseEvent, group: Group, change: GlistGitChange, root?: string): void {
    if (change.state === 'conflict') {
      showMenu(event, [
        { label: t('openFile'), run: () => this.hooks.openConflict(change.path) },
        'separator',
        { label: t('keepMine'), run: () => { void this.resolve(change.path, 'mine', root); } },
        { label: t('takeTheirs'), run: () => { void this.resolve(change.path, 'theirs', root); } },
        { label: t('markResolved'), run: () => { void this.client.run({ kind: 'mark-resolved', paths: [change.path] }, { root }); } },
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
          { label: t('addToGitignore'), run: () => { void this.client.run({ kind: 'ignore', paths: [change.path] }, { root }); } },
          // Deleting is for the project's own files; the engine's and plugins' are read-only here.
          ...(root === undefined ? [{ label: t('delete'), danger: true, run: () => { void this.deleteUnversioned(change); } }] : []),
        ]
        : [{ label: `${t('rollback')}...`, danger: true, run: () => { void this.rollback([change], root); } }]),
    ]);
  }

  // A whole file in one click is easy to do by mistake, so it can be taken back.
  private async resolve(filePath: string, side: 'mine' | 'theirs', root?: string): Promise<void> {
    const result = await this.client.run({ kind: 'resolve', path: filePath, side }, { root });
    if (!result.success) return;
    notify({
      text: t(side === 'mine' ? 'keptMine' : 'tookTheirs').replace('{name}', baseName(filePath)),
      kind: 'success',
      actions: [{ label: t('undo'), run: () => { void this.client.run({ kind: 'unresolve', path: filePath }, { root }); } }],
    });
  }

  private async deleteUnversioned(change: GlistGitChange): Promise<void> {
    if (!window.confirm(`“${baseName(change.path)}”: ${t('confirmDeleteFile')}`)) return;
    await this.hooks.deleteFile(change.path);
    await this.client.refresh();
  }

  private confirmRollback(changes: GlistGitChange[]): boolean {
    return window.confirm(changes.length === 1
      ? t('confirmRollbackOne').replace('{name}', baseName(changes[0].path))
      : t('confirmRollback').replace('{count}', String(changes.length)));
  }

  private async rollback(changes: GlistGitChange[], root?: string): Promise<void> {
    if (changes.length === 0 || !this.confirmRollback(changes)) return;
    await this.client.run({ kind: 'rollback', paths: changes.map((change) => change.path) }, { root });
  }

  // The checked files, the project's and the engine's and plugins', each in its own repository.
  private async rollbackChosen(): Promise<void> {
    const tracked = (changes: GlistGitChange[]): GlistGitChange[] => changes.filter((change) => change.state !== 'untracked');
    const project = tracked(this.included());
    const shared = this.sharedIncluded().map(([dependency, changes]): [GlistGitRepository, GlistGitChange[]] => [dependency, tracked(changes)])
      .filter(([, changes]) => changes.length > 0);
    const all = [...project, ...shared.flatMap(([, changes]) => changes)];
    if (all.length === 0 || !this.confirmRollback(all)) return;
    if (project.length > 0) await this.client.run({ kind: 'rollback', paths: project.map((change) => change.path) });
    for (const [dependency, changes] of shared) {
      await this.client.run({ kind: 'rollback', paths: changes.map((change) => change.path) }, { root: dependency.folder });
    }
  }

  private keydown(event: KeyboardEvent): void {
    const index = this.rows.findIndex((row) => row.dataset.path === this.selected);
    const change = [...(this.client.repository?.changes ?? []), ...this.client.dependencies.flatMap((dependency) => dependency.changes)]
      .find((entry) => entry.path === this.selected);
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

  // The project's chosen files, then the engine's and plugins', each in its own
  // repository with the same message. Amend is only ever for the project's.
  async commit(andPush: boolean): Promise<void> {
    const repository = this.client.repository;
    const message = this.controls.message.value.trim();
    if (!message) { this.controls.message.focus(); return; }
    const pathsOf = (changes: GlistGitChange[]): string[] => changes.flatMap((change) => (change.from ? [change.path, change.from] : [change.path]));
    const paths = pathsOf(this.included());
    const amend = this.controls.amend.checked;
    const merging = Boolean(repository?.operation && repository.operation !== 'rebase');
    const shared = this.sharedIncluded();
    const project = Boolean(repository) && (paths.length > 0 || amend || merging);
    if (!project && shared.length === 0) return;
    if (!(await this.hooks.ensureIdentity())) return;
    if (project) {
      const result = await this.client.run({ kind: 'commit', message, paths, amend }, { busy: 'committing' });
      if (!result.success) return;
    }
    for (const [dependency, changes] of shared) {
      const result = await this.client.run({ kind: 'commit', message, paths: pathsOf(changes), amend: false }, { root: dependency.folder, busy: 'committing' });
      if (!result.success) return;
      changes.forEach((change) => this.includedShared.delete(change.path));
    }
    notify({ text: t('committedMessage').replace('{subject}', message.split('\n')[0]), kind: 'success' });
    this.controls.message.value = '';
    this.controls.amend.checked = false;
    this.draft = '';
    this.saveMessage();
    this.updateButtons();
    if (andPush) this.hooks.push();
  }
}
