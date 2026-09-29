import { showMenu, type MenuEntry } from './context-menu';
import { fileIconElement } from './file-icons';
import { stateLetter, stateText, type GitClient } from './git-client';
import { formDialog } from './git-dialogs';
import { graphRows, type GraphRow } from './git-graph';
import { icon, type IconName } from './icons';
import { t, type TranslationKey } from './localization';
import { baseName } from './paths';
import { fullTime, relativeTime, shortDate } from './time';

// The Git tab under the editor, like JetBrains' Git tool window: the Log with
// its graph and a commit's details, Branches, Remotes, Stashes, and the Console
// of commands the studio ran.

export type GitPanelView = 'log' | 'branches' | 'remotes' | 'stashes' | 'console';

export interface GitPanelHooks {
  projectRoot(): string | null;
  // A file as one commit changed it: base (or nothing) against the commit.
  openCommitDiff(file: GlistGitCommitFile, base: string | null, commit: string): void;
  push(): void;
  update(): void;
  newBranch(start?: string, label?: string): void;
  checkout(ref: string): void;
}

const views: Array<[GitPanelView, TranslationKey]> = [
  ['log', 'gitLog'],
  ['branches', 'gitBranches'],
  ['remotes', 'gitRemotes'],
  ['stashes', 'gitStashes'],
  ['console', 'gitConsole'],
];

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Labels carry their key, so they follow a change of language.
const toolButton = (iconName: IconName, title: TranslationKey, run: () => void): HTMLButtonElement => {
  const button = element('button', 'heading-action');
  button.type = 'button';
  button.title = t(title);
  button.dataset.i18nTitle = title;
  button.setAttribute('aria-label', t(title));
  button.dataset.i18nAriaLabel = title;
  button.append(icon(iconName));
  button.addEventListener('click', run);
  return button;
};

const textButton = (label: TranslationKey, run: () => void, iconName?: IconName): HTMLButtonElement => {
  const button = element('button', 'git-tool-button');
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  const text = element('span', undefined, t(label));
  text.dataset.i18n = label;
  button.append(text);
  button.addEventListener('click', run);
  return button;
};

const graphColors = ['--ansi-blue', '--ansi-green', '--ansi-magenta', '--ansi-yellow', '--ansi-cyan', '--ansi-red', '--file-orange', '--file-pink'];
const laneWidth = 14;
const rowHeight = 24;
const maxLanes = 14;
const svgNamespace = 'http://www.w3.org/2000/svg';

const graphElement = (row: GraphRow, lanes: number): SVGSVGElement => {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('log-graph');
  svg.setAttribute('width', String(lanes * laneWidth));
  svg.setAttribute('height', String(rowHeight));
  svg.setAttribute('aria-hidden', 'true');
  const x = (lane: number): number => Math.min(lane, maxLanes - 1) * laneWidth + laneWidth / 2;
  row.lines.forEach((line) => {
    const path = document.createElementNS(svgNamespace, 'path');
    const [x1, y1, x2, y2] = [x(line.from), line.fromY * rowHeight, x(line.to), line.toY * rowHeight];
    const middle = (y1 + y2) / 2;
    path.setAttribute('d', x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${middle} ${x2} ${middle} ${x2} ${y2}`);
    path.style.stroke = `var(${graphColors[line.color % graphColors.length]})`;
    svg.append(path);
  });
  const node = document.createElementNS(svgNamespace, 'circle');
  node.setAttribute('cx', String(x(row.lane)));
  node.setAttribute('cy', String(rowHeight / 2));
  node.setAttribute('r', '4');
  node.style.fill = `var(${graphColors[row.color % graphColors.length]})`;
  svg.append(node);
  return svg;
};

// A branch or tag beside a commit's subject.
const refBadge = (name: string, current: string | null): HTMLElement => {
  const tag = name.startsWith('tag: ');
  const label = tag ? name.slice(5) : name;
  const badge = element('span', `log-ref ${tag ? 'tag' : label.includes('/') ? 'remote' : 'local'}${label === current ? ' current' : ''}`);
  badge.append(icon(tag ? 'tag' : 'git-branch'), label);
  return badge;
};

// The changed files of a commit or a stash, each opening its diff.
const fileList = (
  files: GlistGitCommitFile[], root: string, open: (file: GlistGitCommitFile) => void,
): HTMLElement => {
  const list = element('div', 'git-files');
  files.forEach((file) => {
    const relative = file.path.startsWith(root) ? file.path.slice(root.length + 1) : file.path;
    const row = element('button', `git-file-row git-${file.state}`);
    row.type = 'button';
    row.title = `${relative}\n${t(stateText[file.state])}`;
    const directory = relative.slice(0, Math.max(0, relative.length - baseName(relative).length - 1));
    row.append(fileIconElement(baseName(file.path)), element('span', 'change-name', baseName(file.path)),
      element('span', 'change-dir', directory), element('span', 'change-state', stateLetter[file.state]));
    row.addEventListener('click', () => open(file));
    list.append(row);
  });
  return list;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

class LogView {
  readonly element = element('div', 'git-log');
  private readonly search = element('input', 'git-search');
  private readonly refSelect = element('select', 'git-select');
  private readonly pathChip = element('button', 'git-path-chip');
  private readonly list = element('div', 'log-list');
  private readonly details = element('div', 'log-details');
  private commits: GlistGitCommit[] = [];
  private selected: string | null = null;
  private complete = false;
  private loading = false;
  private path: string | null = null;
  // A branch or tag to show once the list of them is filled.
  private pendingRef: string | null = null;
  private generation = 0;
  private searchTimer = 0;

  constructor(private readonly client: GitClient, private readonly hooks: GitPanelHooks) {
    const toolbar = element('div', 'git-toolbar');
    this.search.type = 'search';
    this.search.placeholder = t('searchCommits');
    this.search.dataset.i18nPlaceholder = 'searchCommits';
    this.search.addEventListener('input', () => {
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => { void this.load(); }, 300);
    });
    this.refSelect.setAttribute('aria-label', t('gitBranches'));
    this.refSelect.addEventListener('change', () => { void this.load(); });
    this.pathChip.type = 'button';
    this.pathChip.hidden = true;
    this.pathChip.title = t('clearFilter');
    this.pathChip.addEventListener('click', () => { this.path = null; void this.load(); });
    toolbar.append(this.search, this.refSelect, this.pathChip, element('span', 'git-toolbar-space'),
      toolButton('refresh', 'gitRefresh', () => { void this.load(); }),
      toolButton('repo-fetch', 'fetch', () => { void this.client.run({ kind: 'fetch' }, { busy: 'fetching', success: t('fetched') }).then(() => this.load()); }));
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'grid');
    this.list.addEventListener('scroll', () => {
      if (this.list.scrollTop + this.list.clientHeight > this.list.scrollHeight - rowHeight * 10) void this.more();
    });
    this.list.addEventListener('keydown', (event) => this.keydown(event));
    const body = element('div', 'log-body');
    body.append(this.list, this.details);
    this.element.append(toolbar, body);
    this.showDetails(null);
  }

  // One file's history, from the Commit view or the editor.
  showHistory(filePath: string): void {
    this.path = filePath;
    void this.load();
  }

  // A branch's or tag's own history.
  showRef(ref: string): void {
    this.path = null;
    this.search.value = '';
    this.pendingRef = ref;
    void this.load();
  }

  // A commit, from blame: in the history as it is, or found by its hash.
  async select(hash: string): Promise<void> {
    const find = (): GlistGitCommit | undefined => this.commits.find((commit) => commit.hash.startsWith(hash));
    if (!find()) {
      this.path = null;
      this.search.value = '';
      this.refSelect.value = '';
      await this.load();
    }
    if (!find()) {
      this.search.value = hash.slice(0, 12);
      await this.load();
    }
    const found = find();
    if (found) this.choose(found.hash, true);
  }

  async load(): Promise<void> {
    this.generation += 1;
    this.commits = [];
    this.complete = false;
    this.pathChip.hidden = !this.path;
    this.pathChip.replaceChildren(icon('history'), t('historyOf').replace('{name}', this.path ? baseName(this.path) : ''), icon('close'));
    await this.fillRefs();
    await this.more();
  }

  private async fillRefs(): Promise<void> {
    const current = this.refSelect.value;
    let branches: GlistGitBranch[] = [];
    try { branches = await window.glistAPI.gitBranches(); } catch { /* No repository. */ }
    const option = (value: string, label: string): HTMLOptionElement => {
      const node = element('option', undefined, label);
      node.value = value;
      return node;
    };
    this.refSelect.replaceChildren(option('', t('allBranches')), option('HEAD', 'HEAD'),
      ...branches.map((branch) => option(branch.name, branch.name)));
    const wanted = this.pendingRef ?? current;
    if (this.pendingRef && ![...this.refSelect.options].some((entry) => entry.value === wanted)) this.refSelect.append(option(wanted, wanted));
    this.pendingRef = null;
    this.refSelect.value = [...this.refSelect.options].some((entry) => entry.value === wanted) ? wanted : '';
  }

  private async more(): Promise<void> {
    if (this.loading || this.complete || !this.client.repository) {
      if (!this.client.repository) this.render();
      return;
    }
    this.loading = true;
    const generation = this.generation;
    const limit = 300;
    try {
      const page = await window.glistAPI.gitLog({
        ref: this.refSelect.value || undefined,
        text: this.search.value.trim() || undefined,
        path: this.path ?? undefined,
        skip: this.commits.length,
        limit,
      });
      if (generation !== this.generation) return;
      this.commits.push(...page.filter((commit) => !this.commits.some((known) => known.hash === commit.hash)));
      this.complete = page.length < limit;
    } catch (error) {
      if (generation === this.generation) this.list.replaceChildren(element('p', 'git-empty', errorText(error)));
      return;
    } finally {
      if (generation === this.generation) this.loading = false;
    }
    this.render();
  }

  private render(): void {
    const scroll = this.list.scrollTop;
    if (this.commits.length === 0) {
      this.list.replaceChildren(element('p', 'git-empty', t('noCommits')));
      this.showDetails(null);
      return;
    }
    const rows = graphRows(this.commits);
    const lanes = Math.min(maxLanes, Math.max(1, ...rows.map((row) => row.width)));
    const current = this.client.repository?.branch ?? null;
    this.list.style.setProperty('--graph-width', `${lanes * laneWidth + 6}px`);
    this.list.replaceChildren(...this.commits.map((commit, index) => {
      const row = element('div', 'log-row');
      row.dataset.hash = commit.hash;
      row.setAttribute('role', 'row');
      row.classList.toggle('selected', commit.hash === this.selected);
      const subject = element('span', 'log-subject');
      commit.refs.forEach((name) => subject.append(refBadge(name, current)));
      subject.append(element('span', 'log-subject-text', commit.subject));
      subject.title = commit.subject;
      const date = element('span', 'log-date', relativeTime(commit.date * 1000));
      date.title = fullTime(commit.date * 1000);
      row.append(graphElement(rows[index], lanes), subject, element('span', 'log-author', commit.author), date);
      row.addEventListener('click', () => this.choose(commit.hash));
      row.addEventListener('contextmenu', (event) => { this.choose(commit.hash); showMenu(event, this.menu(commit)); });
      return row;
    }));
    this.list.scrollTop = scroll;
    if (!this.selected || !this.commits.some((commit) => commit.hash === this.selected)) this.showDetails(null);
  }

  private choose(hash: string, reveal = false): void {
    this.selected = hash;
    this.list.querySelectorAll<HTMLElement>('.log-row').forEach((row) => {
      const active = row.dataset.hash === hash;
      row.classList.toggle('selected', active);
      if (active && reveal) row.scrollIntoView({ block: 'center' });
    });
    void this.showDetails(hash);
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = this.commits.findIndex((commit) => commit.hash === this.selected);
    const next = this.commits[Math.min(this.commits.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    this.choose(next.hash);
    this.list.querySelector(`[data-hash="${next.hash}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private async showDetails(hash: string | null): Promise<void> {
    if (!hash) {
      this.details.replaceChildren(element('p', 'git-empty', t('selectCommit')));
      return;
    }
    let details: GlistGitCommitDetails;
    try { details = await window.glistAPI.gitCommitDetails(hash); } catch (error) {
      this.details.replaceChildren(element('p', 'git-empty', errorText(error)));
      return;
    }
    if (this.selected !== hash) return;
    const current = this.client.repository?.branch ?? null;
    const heading = element('h3', 'log-details-subject', details.subject);
    const meta = element('p', 'log-details-meta');
    const copy = element('button', 'log-hash');
    copy.type = 'button';
    copy.title = t('copyHash');
    copy.append(icon('copy'), details.short);
    copy.addEventListener('click', () => { void navigator.clipboard.writeText(details.hash); });
    const author = element('span', undefined, `${details.author} <${details.email}>`);
    const date = element('span', undefined, fullTime(details.date * 1000));
    meta.append(copy, author, date);
    const nodes: HTMLElement[] = [heading, meta];
    if (details.refs.length > 0) {
      const refs = element('p', 'log-details-refs');
      details.refs.forEach((name) => refs.append(refBadge(name, current)));
      nodes.push(refs);
    }
    const body = details.message.split('\n').slice(1).join('\n').trim();
    if (body) nodes.push(element('pre', 'log-details-body', body));
    nodes.push(fileList(details.files, this.hooks.projectRoot() ?? '', (file) => this.hooks.openCommitDiff(file, details.base, details.hash)));
    this.details.replaceChildren(...nodes);
  }

  private menu(commit: GlistGitCommit): MenuEntry[] {
    const run = (action: GlistGitAction, success?: string): void => {
      void this.client.run(action, { success }).then(() => this.load());
    };
    const branch = this.client.repository?.branch;
    return [
      { label: t('copyHash'), run: () => { void navigator.clipboard.writeText(commit.hash); } },
      'separator',
      { label: t('checkoutRevision'), run: () => this.hooks.checkout(commit.hash) },
      { label: t('newBranch'), run: () => this.hooks.newBranch(commit.hash, commit.short) },
      {
        label: t('newTag'),
        run: () => {
          void formDialog({
            title: t('newTag').replace('...', ''),
            hint: `${commit.short} ${commit.subject}`,
            submit: t('create'),
            fields: [
              { kind: 'text', key: 'name', label: t('tagName'), required: true },
              { kind: 'text', key: 'message', label: t('tagMessage') },
            ],
          }).then((values) => {
            if (values) run({ kind: 'create-tag', name: String(values.name), commit: commit.hash, message: String(values.message) });
          });
        },
      },
      'separator',
      { label: t('cherryPick'), run: () => run({ kind: 'cherry-pick', commit: commit.hash }), disabled: !branch },
      { label: t('revertCommit'), run: () => run({ kind: 'revert', commit: commit.hash }), disabled: !branch },
      { label: t('resetHere'), run: () => { void this.reset(commit); }, disabled: !branch, danger: true },
    ];
  }

  private async reset(commit: GlistGitCommit): Promise<void> {
    const values = await formDialog({
      title: t('resetTitle').replace('{branch}', this.client.repository?.branch ?? 'HEAD').replace('{hash}', commit.short),
      hint: commit.subject,
      submit: t('reset'),
      danger: true,
      fields: [{
        kind: 'choice',
        key: 'mode',
        value: 'mixed',
        options: [
          { value: 'mixed', label: t('resetMixed') },
          { value: 'soft', label: t('resetSoft') },
          { value: 'hard', label: t('resetHard') },
        ],
      }],
    });
    if (!values) return;
    const mode = values.mode === 'soft' || values.mode === 'hard' ? values.mode : 'mixed';
    if (mode === 'hard' && !window.confirm(t('confirmResetHard'))) return;
    await this.client.run({ kind: 'reset', commit: commit.hash, mode });
    await this.load();
  }
}

class BranchesView {
  readonly element = element('div', 'git-branches');
  private readonly list = element('div', 'git-list');
  private selected: { kind: 'local' | 'remote' | 'tag'; name: string } | null = null;

  constructor(private readonly client: GitClient, private readonly hooks: GitPanelHooks, private readonly showLog: (ref: string) => void) {
    const toolbar = element('div', 'git-toolbar');
    toolbar.append(
      textButton('newBranch', () => hooks.newBranch(), 'add'),
      element('span', 'git-toolbar-space'),
      toolButton('refresh', 'gitRefresh', () => { void this.load(); }),
      toolButton('repo-fetch', 'fetch', () => { void this.client.run({ kind: 'fetch' }, { busy: 'fetching', success: t('fetched') }).then(() => this.load()); }),
    );
    this.element.append(toolbar, this.list);
  }

  async load(): Promise<void> {
    if (!this.client.repository) { this.list.replaceChildren(); return; }
    let branches: GlistGitBranch[] = [];
    let tags: GlistGitTag[] = [];
    try { [branches, tags] = await Promise.all([window.glistAPI.gitBranches(), window.glistAPI.gitTags()]); } catch (error) {
      this.list.replaceChildren(element('p', 'git-empty', errorText(error)));
      return;
    }
    const local = branches.filter((branch) => !branch.remote).sort((left, right) => Number(right.current) - Number(left.current));
    const remote = branches.filter((branch) => branch.remote);
    const nodes: HTMLElement[] = [];
    const section = (key: TranslationKey, count: number): void => {
      const heading = element('div', 'git-section');
      heading.append(element('span', undefined, t(key)), element('span', 'change-count', String(count)));
      nodes.push(heading);
    };
    section('local', local.length);
    local.forEach((branch) => nodes.push(this.branchRow('local', branch)));
    if (remote.length > 0) {
      section('remote', remote.length);
      remote.forEach((branch) => nodes.push(this.branchRow('remote', branch)));
    }
    if (tags.length > 0) {
      section('tags', tags.length);
      tags.forEach((tag) => nodes.push(this.row('tag', tag.name, 'tag', [], tag.subject, tag.date)));
    }
    this.list.replaceChildren(...nodes);
  }

  private branchRow(kind: 'local' | 'remote', branch: GlistGitBranch): HTMLElement {
    const badges: HTMLElement[] = [];
    if (branch.current) badges.push(element('span', 'git-badge current', t('currentBranch')));
    if (branch.ahead) { const up = element('span', 'git-badge'); up.append(icon('arrow-up'), String(branch.ahead)); badges.push(up); }
    if (branch.behind) { const down = element('span', 'git-badge'); down.append(icon('arrow-down'), String(branch.behind)); badges.push(down); }
    if (branch.gone) badges.push(element('span', 'git-badge gone', t('branchGone')));
    const row = this.row(kind, branch.name, 'git-branch', badges, branch.subject, branch.date);
    if (branch.upstream) row.title = `${branch.name} → ${branch.upstream}`;
    row.classList.toggle('current', branch.current);
    return row;
  }

  private row(kind: 'local' | 'remote' | 'tag', name: string, iconName: IconName, badges: HTMLElement[], subject: string, date: number): HTMLElement {
    const row = element('div', 'git-row');
    row.tabIndex = -1;
    const label = element('span', 'git-row-name');
    label.append(icon(iconName), element('span', undefined, name), ...badges);
    const when = element('span', 'git-row-date', shortDate(date * 1000));
    when.title = fullTime(date * 1000);
    row.append(label, element('span', 'git-row-detail', subject), when);
    row.classList.toggle('selected', this.selected?.kind === kind && this.selected.name === name);
    row.addEventListener('click', () => {
      this.selected = { kind, name };
      this.list.querySelectorAll('.git-row.selected').forEach((other) => other.classList.remove('selected'));
      row.classList.add('selected');
    });
    row.addEventListener('dblclick', () => { if (!row.classList.contains('current')) this.hooks.checkout(name); });
    row.addEventListener('contextmenu', (event) => { row.click(); showMenu(event, this.menu(kind, name, row.classList.contains('current'))); });
    return row;
  }

  private menu(kind: 'local' | 'remote' | 'tag', name: string, current: boolean): MenuEntry[] {
    const branch = this.client.repository?.branch ?? 'HEAD';
    const run = async (action: GlistGitAction, success?: string): Promise<GlistGitResult> => {
      const result = await this.client.run(action, { success });
      await this.load();
      return result;
    };
    const entries: MenuEntry[] = [
      { label: t('checkout'), run: () => this.hooks.checkout(name), disabled: current },
      { label: t('newBranch'), run: () => this.hooks.newBranch(name, name) },
      { label: t('gitLogMenu'), run: () => this.showLog(name) },
    ];
    if (kind !== 'tag') {
      entries.push('separator',
        { label: t('mergeInto').replace('{branch}', branch), run: () => { void run({ kind: 'merge', ref: name }); }, disabled: current },
        { label: t('rebaseOnto').replace('{branch}', branch), run: () => { void run({ kind: 'rebase', onto: name }); }, disabled: current });
    }
    entries.push('separator');
    if (kind === 'local') {
      entries.push({
        label: `${t('rename')}...`,
        run: () => {
          void formDialog({
            title: t('rename'),
            submit: t('rename'),
            fields: [{ kind: 'text', key: 'name', label: t('branchName'), value: name, required: true }],
          }).then((values) => { if (values && values.name !== name) void run({ kind: 'rename-branch', from: name, to: String(values.name) }); });
        },
      });
    }
    if (kind === 'tag') {
      entries.push({
        label: t('deleteBranch'),
        danger: true,
        run: () => { if (window.confirm(t('confirmDeleteTag').replace('{name}', name))) void run({ kind: 'delete-tag', name }); },
      });
    } else {
      entries.push({
        label: t('deleteBranch'),
        danger: true,
        disabled: current,
        run: () => { void this.deleteBranch(kind === 'remote', name); },
      });
    }
    return entries;
  }

  private async deleteBranch(remote: boolean, name: string): Promise<void> {
    const question = remote ? 'confirmDeleteRemoteBranch' : 'confirmDeleteBranch';
    if (!window.confirm(t(question).replace('{name}', name))) return;
    const result = await this.client.run({ kind: 'delete-branch', name, remote }, { quiet: (outcome) => Boolean(outcome.notMerged) });
    if (result.notMerged && window.confirm(t('confirmForceDelete').replace('{name}', name))) {
      await this.client.run({ kind: 'delete-branch', name, remote, force: true });
    }
    await this.load();
  }
}

class RemotesView {
  readonly element = element('div', 'git-remotes');
  private readonly list = element('div', 'git-list');

  constructor(private readonly client: GitClient) {
    const toolbar = element('div', 'git-toolbar');
    toolbar.append(
      textButton('addRemote', () => { void this.add(); }, 'add'),
      element('span', 'git-toolbar-space'),
      toolButton('refresh', 'gitRefresh', () => { void this.load(); }),
      toolButton('repo-fetch', 'fetch', () => { void this.client.run({ kind: 'fetch' }, { busy: 'fetching', success: t('fetched') }); }),
    );
    this.element.append(toolbar, this.list);
  }

  async load(): Promise<void> {
    if (!this.client.repository) { this.list.replaceChildren(); return; }
    let remotes: GlistGitRemote[] = [];
    try { remotes = await window.glistAPI.gitRemotes(); } catch (error) {
      this.list.replaceChildren(element('p', 'git-empty', errorText(error)));
      return;
    }
    if (remotes.length === 0) {
      this.list.replaceChildren(element('p', 'git-empty', t('noRemotes')));
      return;
    }
    this.list.replaceChildren(...remotes.map((remote) => {
      const row = element('div', 'git-row');
      const name = element('span', 'git-row-name');
      name.append(icon('remote'), element('span', undefined, remote.name));
      row.append(name, element('span', 'git-row-detail', remote.push && remote.push !== remote.fetch ? `${remote.fetch}  ↑ ${remote.push}` : remote.fetch));
      const menu = (event: MouseEvent): void => showMenu(event, [
        { label: t('fetch'), run: () => { void this.client.run({ kind: 'fetch' }, { busy: 'fetching', success: t('fetched') }); } },
        { label: t('editRemote'), run: () => { void this.edit(remote); } },
        'separator',
        {
          label: t('removeRemote'),
          danger: true,
          run: () => {
            if (window.confirm(t('confirmRemoveRemote').replace('{name}', remote.name))) {
              void this.client.run({ kind: 'remove-remote', name: remote.name }).then(() => this.load());
            }
          },
        },
      ]);
      row.addEventListener('contextmenu', menu);
      row.addEventListener('dblclick', () => { void this.edit(remote); });
      return row;
    }));
  }

  async add(): Promise<void> {
    let remotes: GlistGitRemote[] = [];
    try { remotes = await window.glistAPI.gitRemotes(); } catch { /* None yet. */ }
    const values = await formDialog({
      title: t('addRemote').replace('...', ''),
      submit: t('create'),
      fields: [
        { kind: 'text', key: 'name', label: t('remoteName'), value: remotes.some((remote) => remote.name === 'origin') ? '' : 'origin', required: true },
        { kind: 'text', key: 'url', label: t('remoteUrl'), placeholder: 'https://github.com/user/project.git', required: true, autofocus: true },
      ],
      validate: async (entered) => {
        const result = await window.glistAPI.gitRun({ kind: 'add-remote', name: String(entered.name), url: String(entered.url) });
        return result.success ? null : result.message;
      },
    });
    if (values) await this.client.refresh();
    await this.load();
  }

  private async edit(remote: GlistGitRemote): Promise<void> {
    const values = await formDialog({
      title: remote.name,
      submit: t('saveButton'),
      fields: [{ kind: 'text', key: 'url', label: t('remoteUrl'), value: remote.fetch, required: true }],
    });
    if (values) await this.client.run({ kind: 'set-remote-url', name: remote.name, url: String(values.url) });
    await this.load();
  }
}

class StashesView {
  readonly element = element('div', 'git-stashes');
  private readonly list = element('div', 'git-list');
  private readonly details = element('div', 'log-details');
  private selected: string | null = null;

  constructor(private readonly client: GitClient, private readonly hooks: GitPanelHooks) {
    const toolbar = element('div', 'git-toolbar');
    toolbar.append(
      textButton('stashChanges', () => { void this.stash(); }, 'git-stash'),
      element('span', 'git-toolbar-space'),
      toolButton('refresh', 'gitRefresh', () => { void this.load(); }),
    );
    const body = element('div', 'log-body');
    body.append(this.list, this.details);
    this.element.append(toolbar, body);
  }

  async stash(): Promise<void> {
    const values = await formDialog({
      title: t('stashChanges').replace('...', ''),
      submit: t('stashChanges').replace('...', ''),
      fields: [
        { kind: 'text', key: 'message', label: t('stashMessage') },
        { kind: 'checkbox', key: 'untracked', label: t('stashUntracked'), value: true },
      ],
    });
    if (!values) return;
    await this.client.run({ kind: 'stash', message: String(values.message), untracked: Boolean(values.untracked) });
    await this.load();
  }

  async load(): Promise<void> {
    if (!this.client.repository) { this.list.replaceChildren(); this.details.replaceChildren(); return; }
    let stashes: GlistGitStash[] = [];
    try { stashes = await window.glistAPI.gitStashes(); } catch (error) {
      this.list.replaceChildren(element('p', 'git-empty', errorText(error)));
      return;
    }
    if (stashes.length === 0) {
      this.list.replaceChildren(element('p', 'git-empty', t('noStashes')));
      this.details.replaceChildren();
      return;
    }
    if (!stashes.some((stash) => stash.name === this.selected)) this.selected = null;
    this.list.replaceChildren(...stashes.map((stash) => {
      const row = element('div', 'git-row');
      row.classList.toggle('selected', stash.name === this.selected);
      const name = element('span', 'git-row-name');
      name.append(icon('git-stash'), element('span', undefined, stash.message));
      const when = element('span', 'git-row-date', relativeTime(stash.date * 1000));
      when.title = fullTime(stash.date * 1000);
      const actions = element('span', 'git-row-actions');
      actions.append(
        toolButton('git-stash-apply', 'applyStash', () => { void this.unstash(stash, false); }),
        toolButton('git-stash-pop', 'popStash', () => { void this.unstash(stash, true); }),
        toolButton('trash', 'dropStash', () => { void this.drop(stash); }),
      );
      row.append(name, element('span', 'git-row-detail', stash.name), when, actions);
      row.addEventListener('click', () => {
        this.selected = stash.name;
        this.list.querySelectorAll('.git-row.selected').forEach((other) => other.classList.remove('selected'));
        row.classList.add('selected');
        void this.showFiles(stash.name);
      });
      row.addEventListener('contextmenu', (event) => showMenu(event, [
        { label: t('applyStash'), run: () => { void this.unstash(stash, false); } },
        { label: t('popStash'), run: () => { void this.unstash(stash, true); } },
        'separator',
        { label: t('dropStash'), danger: true, run: () => { void this.drop(stash); } },
      ]));
      return row;
    }));
    if (this.selected) void this.showFiles(this.selected);
    else this.details.replaceChildren(element('p', 'git-empty', t('selectCommit')));
  }

  private async showFiles(name: string): Promise<void> {
    try {
      const details = await window.glistAPI.gitCommitDetails(name);
      if (this.selected !== name) return;
      this.details.replaceChildren(
        element('h3', 'log-details-subject', details.subject),
        fileList(details.files, this.hooks.projectRoot() ?? '', (file) => this.hooks.openCommitDiff(file, details.base, name)),
      );
    } catch (error) {
      this.details.replaceChildren(element('p', 'git-empty', errorText(error)));
    }
  }

  private async unstash(stash: GlistGitStash, pop: boolean): Promise<void> {
    await this.client.run({ kind: 'unstash', name: stash.name, pop });
    await this.load();
  }

  private async drop(stash: GlistGitStash): Promise<void> {
    if (!window.confirm(t('confirmDropStash').replace('{name}', stash.message))) return;
    await this.client.run({ kind: 'drop-stash', name: stash.name });
    await this.load();
  }
}

// The commands the studio ran and what they printed. Progress that git redraws
// in place, with carriage returns, keeps only its latest state.
class ConsoleView {
  readonly element = element('div', 'git-console-view');
  private readonly output = element('pre', 'output git-console');
  private current: { node: HTMLElement; text: string } | null = null;

  constructor() {
    const toolbar = element('div', 'git-toolbar');
    toolbar.append(element('span', 'git-toolbar-space'), toolButton('clear-all', 'clearConsole', () => {
      this.output.replaceChildren();
      this.current = null;
    }));
    this.element.append(toolbar, this.output);
    window.glistAPI.onGitConsole((entry) => this.add(entry));
  }

  private add(entry: GlistGitConsoleEntry): void {
    if (entry.kind === 'command') {
      const line = element('span', 'ansi-cyan', `${this.output.childNodes.length ? '\n' : ''}> ${entry.text}\n`);
      this.output.append(line);
      this.current = null;
    } else if (entry.kind === 'error') {
      this.output.append(element('span', 'ansi-red', `${entry.text}\n`));
      this.current = null;
    } else {
      if (!this.current) {
        this.current = { node: element('span'), text: '' };
        this.output.append(this.current.node);
      }
      this.current.text += entry.text;
      this.current.node.textContent = this.current.text.split('\n').map((line) => line.split('\r').filter(Boolean).pop() ?? '').join('\n');
    }
    this.output.scrollTop = this.output.scrollHeight;
  }
}

export class GitPanel {
  private view: GitPanelView = 'log';
  private readonly tabs = new Map<GitPanelView, HTMLButtonElement>();
  private readonly log: LogView;
  private readonly branches: BranchesView;
  private readonly remotes: RemotesView;
  private readonly stashes: StashesView;
  private readonly console = new ConsoleView();
  private readonly body = element('div', 'git-panel-body');
  // What the views last loaded for; they load again when it changes.
  private seen = '';
  private stale = new Set<GitPanelView>(views.map(([view]) => view));
  private visible = false;

  constructor(host: HTMLElement, private readonly client: GitClient, hooks: GitPanelHooks) {
    this.log = new LogView(client, hooks);
    this.branches = new BranchesView(client, hooks, (ref) => { this.show('log', false); this.stale.delete('log'); this.log.showRef(ref); });
    this.remotes = new RemotesView(client);
    this.stashes = new StashesView(client, hooks);
    const tabs = element('div', 'git-panel-tabs');
    tabs.setAttribute('role', 'tablist');
    views.forEach(([view, key]) => {
      const tab = element('button', 'git-panel-tab', t(key));
      tab.dataset.i18n = key;
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => this.show(view));
      this.tabs.set(view, tab);
      tabs.append(tab);
    });
    host.append(tabs, this.body);
    client.onStatus((status) => {
      const repository = status?.repository;
      const signature = repository ? [repository.root, repository.head, repository.branch, repository.upstream, repository.ahead,
        repository.behind, repository.stashes, repository.operation].join('|') : '';
      if (signature === this.seen) return;
      this.seen = signature;
      views.forEach(([view]) => this.stale.add(view));
      if (this.visible) this.show(this.view);
    });
    this.show('log', false);
  }

  // The panel is on screen or not; views load when they are seen.
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.show(this.view);
  }

  show(view: GitPanelView, load = true): void {
    this.view = view;
    this.tabs.forEach((tab, key) => {
      tab.classList.toggle('active', key === view);
      tab.setAttribute('aria-selected', String(key === view));
    });
    const content = { log: this.log, branches: this.branches, remotes: this.remotes, stashes: this.stashes, console: this.console }[view];
    if (this.body.firstElementChild !== content.element) this.body.replaceChildren(content.element);
    if (!load || !this.stale.has(view)) return;
    this.stale.delete(view);
    if (view !== 'console') void (content as { load(): Promise<void> }).load();
  }

  showHistory(filePath: string): void {
    this.show('log', false);
    this.stale.delete('log');
    this.log.showHistory(filePath);
  }

  async showCommit(hash: string): Promise<void> {
    this.show('log');
    await this.log.select(hash);
  }

  async addRemote(): Promise<void> {
    this.show('remotes');
    await this.remotes.add();
  }

  async stash(): Promise<void> {
    this.show('stashes');
    await this.stashes.stash();
  }

  // After something the panel did not run itself changed the repository.
  reload(): void {
    views.forEach(([view]) => this.stale.add(view));
    if (this.visible) this.show(this.view);
  }
}
