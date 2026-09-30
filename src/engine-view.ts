import { updateCheckout, type CheckoutTarget, type CheckoutUpdateHooks } from './checkout-updates';
import { icon } from './icons';
import { t, type TranslationKey } from './localization';
import { fullTime, relativeTime } from './time';

// The Engine view in the side bar: the Glist Engine the open project uses, or
// the installed one, with its branch and commit, where it stands against
// GlistEngine, the commits there it does not have yet, and Update, which
// works as the Plugins view's does (checkout-updates.ts).

const source = 'GlistEngine/GlistEngine';

export const engineTarget: CheckoutTarget = {
  name: 'GlistEngine',
  source,
  run: (choice, resolve) => window.glistAPI.updateEngine(choice, resolve),
};

export interface EngineHooks {
  updates: CheckoutUpdateHooks;
  // Glist is not installed here: its installer.
  install(): void;
  // Opens the engine's repository in the Git tab; offered while the Git tools are on.
  showInGit(folder: string): void;
  // The engine was updated.
  changed(): void;
}

const fill = (key: TranslationKey, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), t(key));

export class EngineView {
  private state: GlistEngineCheckout | null = null;
  private busy = false;

  constructor(
    private readonly host: HTMLElement,
    refresh: HTMLButtonElement,
    private readonly activity: HTMLElement,
    private readonly hooks: EngineHooks,
  ) {
    refresh.addEventListener('click', () => { void this.load(true); });
  }

  // Asks GlistEngine for new commits first when fetch is set; says whether there are some to bring in.
  async load(fetch = false): Promise<boolean> {
    this.state = await window.glistAPI.engineCheckout(fetch).catch((): null => null);
    this.render();
    return this.updatable();
  }

  // On its source's default branch, with commits to bring in.
  updatable(): boolean {
    const state = this.state;
    return Boolean(state?.remote && state.branch && state.branch === state.defaultBranch && (state.behind ?? 0) > 0);
  }

  async update(): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await updateCheckout(engineTarget, this.hooks.updates);
    } finally {
      this.busy = false;
      await this.load();
      this.hooks.changed();
    }
  }

  private render(): void {
    const state = this.state;
    this.activity.classList.toggle('has-updates', this.updatable());
    if (!state) { this.host.replaceChildren(); return; }
    const message = (text: string): HTMLElement => Object.assign(document.createElement('p'), { className: 'plugins-message', textContent: text });
    if (!state.found) {
      const install = Object.assign(document.createElement('button'), { type: 'button', className: 'empty-tree-action primary', textContent: t('installGlist') });
      install.addEventListener('click', () => this.hooks.install());
      this.host.replaceChildren(message(fill('engineNotFound', { location: state.location })), install);
      return;
    }
    if (!state.repository) {
      this.host.replaceChildren(message(fill('engineNotCheckout', { location: state.location })));
      return;
    }
    const card = document.createElement('div');
    card.className = 'engine-card';
    const header = document.createElement('div');
    header.className = 'plugin-header';
    const name = Object.assign(document.createElement('span'), { className: 'plugin-name', textContent: 'GlistEngine' });
    const actions = Object.assign(document.createElement('span'), { className: 'plugin-actions' });
    if (this.busy) actions.append(Object.assign(document.createElement('span'), { className: 'plugin-working', textContent: t('pluginWorking') }));
    else if (this.updatable()) {
      const update = document.createElement('button');
      update.type = 'button';
      update.className = 'plugin-action primary';
      update.title = t('updatePluginTitle').replace('{source}', source);
      update.append(icon('sync'), Object.assign(document.createElement('span'), { textContent: t('updateButton') }));
      update.addEventListener('click', () => { void this.update(); });
      actions.append(update);
    }
    header.append(name, actions);

    const list = document.createElement('dl');
    list.className = 'engine-facts';
    const fact = (term: string, ...value: Array<string | Node>): void => {
      const detail = document.createElement('dd');
      detail.append(...value);
      list.append(Object.assign(document.createElement('dt'), { textContent: term }), detail);
    };
    fact(t('aboutBranch'), state.branch ?? t('aboutNoBranch'));
    if (state.head) {
      const hash = Object.assign(document.createElement('code'), { textContent: state.head.hash.slice(0, 10), title: state.head.hash });
      const when = Object.assign(document.createElement('span'), {
        className: 'engine-when', textContent: relativeTime(state.head.date * 1000), title: fullTime(state.head.date * 1000),
      });
      fact(t('aboutCommit'), hash, ' ', when, document.createElement('br'), state.head.subject);
    }
    fact(t('engineSource'), state.remote ? fill('engineSourceRemote', { source, remote: state.remote }) : fill('engineNoSource', { source }));
    fact(t('aboutFolder'), state.location);

    // Where it stands: new commits there, and work of the user's own here.
    const standing: string[] = [];
    if (state.fetchError) standing.push(fill('engineFetchFailed', { source, error: state.fetchError }));
    else if (state.remote && state.branch && state.defaultBranch && state.branch !== state.defaultBranch) {
      standing.push(fill('engineOtherBranch', { branch: state.branch, main: state.defaultBranch }));
    } else if ((state.behind ?? 0) > 0) standing.push(t('pluginBehind').replace('{count}', String(state.behind)).replace('{source}', source));
    else if (state.remote) standing.push(fill('engineUpToDate', { source }));
    const count = (one: TranslationKey, many: TranslationKey, value: number): string => (value === 1 ? t(one) : fill(many, { count: String(value) }));
    if ((state.ahead ?? 0) > 0) standing.push(count('updateWorkCommit', 'updateWorkCommits', state.ahead ?? 0));
    if ((state.changed ?? 0) > 0) standing.push(count('updateWorkFile', 'updateWorkFiles', state.changed ?? 0));
    const status = Object.assign(document.createElement('div'), {
      className: `plugin-state${this.updatable() ? ' update' : ''}`, textContent: standing.join(' · '),
    });
    card.append(header, list, status);

    if ((state.incoming?.length ?? 0) > 0) {
      const heading = Object.assign(document.createElement('div'), { className: 'plugins-heading', textContent: fill('engineIncoming', { source }) });
      const commits = document.createElement('ul');
      commits.className = 'engine-incoming';
      commits.append(...(state.incoming ?? []).map((entry) => {
        const item = document.createElement('li');
        item.append(Object.assign(document.createElement('code'), { textContent: entry.hash.slice(0, 7) }), ` ${entry.subject}`);
        return item;
      }));
      card.append(heading, commits);
    }
    if (this.hooks.updates.gitTools()) {
      const show = Object.assign(document.createElement('button'), { type: 'button', className: 'engine-git', textContent: t('showInGit') });
      const folder = state.folder;
      show.addEventListener('click', () => this.hooks.showInGit(folder));
      card.append(show);
    }
    this.host.replaceChildren(card);
  }
}
