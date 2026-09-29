import { formDialog } from './git-dialogs';
import { t, type TranslationKey } from './localization';
import { notify } from './notifications';

// The Plugins view in the side bar: GlistPlugins' plugins to install into
// glistplugins with one click, the installed ones to add to the project, and
// updates for those that came from GlistPlugins. Updates are also checked in
// the background and offered in a message, which runs the same steps.

export interface PluginsHooks {
  hasProject(): boolean;
  // A plugin was added to or taken out of the project, or installed.
  projectChanged(): void;
}

const checkEvery = 6 * 60 * 60 * 1000;

// Updates one plugin; with work of the user's own, asks before putting it aside.
export const updatePlugin = async (name: string): Promise<boolean> => {
  let result = await window.glistAPI.updatePlugin(name).catch((error: Error): GlistPluginResult => ({ success: false, message: error.message }));
  if (result.confirm) {
    const { changed, ahead } = result.confirm;
    const count = (one: TranslationKey, many: TranslationKey, value: number): string => (value === 1 ? t(one) : t(many).replace('{count}', String(value)));
    const work = [
      ...(changed > 0 ? [count('pluginKeepFile', 'pluginKeepFiles', changed)] : []),
      ...(ahead > 0 ? [count('pluginKeepCommit', 'pluginKeepCommits', ahead)] : []),
    ].join(t('pluginKeepAnd'));
    const how = [...(changed > 0 ? [t('pluginKeepStash')] : []), ...(ahead > 0 ? [t('pluginKeepBranch')] : [])].join(t('pluginKeepAnd'));
    const answer = await formDialog({
      title: t('pluginKeepTitle').replace('{name}', name),
      hint: t('pluginKeepHint').replace(/\{name\}/g, name).replace('{work}', work).replace('{how}', how),
      fields: [],
      submit: t('pluginKeepButton'),
    });
    if (!answer) return false;
    result = await window.glistAPI.updatePlugin(name, true).catch((error: Error): GlistPluginResult => ({ success: false, message: error.message }));
  }
  if (result.success) {
    const kept = [
      ...(result.kept?.stash ? [t('pluginKeptStash').replace('{stash}', result.kept.stash)] : []),
      ...(result.kept?.branch ? [t('pluginKeptBranch').replace('{branch}', result.kept.branch)] : []),
    ].join(' ');
    notify({ text: t('pluginUpdated').replace('{name}', name), kind: 'success', ...(kept ? { detail: kept } : {}) });
  } else {
    notify({ text: t('pluginUpdateFailed').replace('{name}', name), detail: result.message, kind: 'error' });
  }
  return result.success;
};

export class PluginsView {
  private list: GlistPluginList | null = null;
  private busy = new Set<string>();
  private told = '';

  constructor(
    private readonly host: HTMLElement,
    private readonly search: HTMLInputElement,
    refresh: HTMLButtonElement,
    private readonly activity: HTMLElement,
    private readonly hooks: PluginsHooks,
  ) {
    search.addEventListener('input', () => this.render());
    refresh.addEventListener('click', () => { void this.load(true); });
  }

  async load(askGlistPlugins = false): Promise<void> {
    this.list = await window.glistAPI.listPlugins(askGlistPlugins).catch((error: Error): GlistPluginList => ({ plugins: [], folder: '', gitFound: true, error: error.message }));
    this.render();
  }

  // In the background: GlistPlugins' new commits for installed plugins, said once per set.
  watch(): void {
    const check = async (): Promise<void> => {
      const outdated = await window.glistAPI.checkPluginUpdates().catch((): GlistPlugin[] => []);
      await this.load();
      const names = outdated.map((plugin) => plugin.name);
      if (names.length === 0 || names.join() === this.told) return;
      this.told = names.join();
      notify({
        text: t('pluginUpdatesNotice').replace('{names}', names.join(', ')),
        actions: [{ label: t('updatePlugins'), run: () => { void this.updateAll(names); } }],
      });
    };
    window.setTimeout(() => { void check(); }, 20000);
    window.setInterval(() => { void check(); }, checkEvery);
  }

  private async updateAll(names: string[]): Promise<void> {
    for (const name of names) await this.run(name, () => updatePlugin(name));
    this.told = '';
  }

  private async run(name: string, task: () => Promise<unknown>): Promise<void> {
    this.busy.add(name);
    this.render();
    try {
      await task();
    } finally {
      this.busy.delete(name);
      await this.load();
      this.hooks.projectChanged();
    }
  }

  private async install(plugin: GlistPlugin): Promise<void> {
    await this.run(plugin.name, async () => {
      const result = await window.glistAPI.installPlugin(plugin.name).catch((error: Error): GlistPluginResult => ({ success: false, message: error.message }));
      notify(result.success
        ? { text: t('pluginInstalled').replace('{name}', plugin.name), kind: 'success' }
        : { text: t('pluginInstallFailed').replace('{name}', plugin.name), detail: result.message, kind: 'error' });
    });
  }

  private async use(plugin: GlistPlugin, on: boolean): Promise<void> {
    await this.run(plugin.name, async () => {
      const result = await window.glistAPI.usePlugin(plugin.name, on).catch((error: Error): GlistPluginResult => ({ success: false, message: error.message }));
      if (!result.success) notify({ text: t('pluginUseFailed').replace('{name}', plugin.name), detail: result.message, kind: 'error' });
    });
  }

  private render(): void {
    const list = this.list;
    const outdated = list?.plugins.filter((plugin) => (plugin.behind ?? 0) > 0 && plugin.official && plugin.branch === plugin.defaultBranch) ?? [];
    this.activity.classList.toggle('has-updates', outdated.length > 0);
    if (!list) return;
    const words = this.search.value.trim().toLowerCase();
    const shown = list.plugins.filter((plugin) => !words || `${plugin.name} ${plugin.description}`.toLowerCase().includes(words));
    const nodes: HTMLElement[] = [];
    if (!list.gitFound) nodes.push(this.message(t('pluginsNeedGit')));
    if (list.error) nodes.push(this.message(`${t('pluginsListFailed')}: ${list.error}`));
    const section = (title: string, plugins: GlistPlugin[]): void => {
      if (plugins.length === 0) return;
      const heading = document.createElement('div');
      heading.className = 'plugins-heading';
      heading.textContent = title;
      nodes.push(heading, ...plugins.map((plugin) => this.row(plugin, list.gitFound)));
    };
    section(t('pluginsInstalled'), shown.filter((plugin) => plugin.installed));
    section(t('pluginsAvailable'), shown.filter((plugin) => !plugin.installed));
    this.host.replaceChildren(...nodes);
  }

  private message(text: string): HTMLElement {
    const paragraph = document.createElement('p');
    paragraph.className = 'plugins-message';
    paragraph.textContent = text;
    return paragraph;
  }

  // The name with Install or Update at its right, the description, then where
  // an installed plugin stands with Add to Project or Remove from Project beside it.
  private row(plugin: GlistPlugin, gitFound: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const busy = this.busy.has(plugin.name);
    const button = (label: string, className: string, run: () => void): HTMLButtonElement => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = className;
      node.textContent = label;
      node.addEventListener('click', run);
      return node;
    };
    const header = document.createElement('div');
    header.className = 'plugin-header';
    const name = document.createElement('span');
    name.className = 'plugin-name';
    name.textContent = plugin.name;
    name.title = plugin.name;
    header.append(name);
    const updatable = plugin.installed && plugin.official && plugin.branch === plugin.defaultBranch && (plugin.behind ?? 0) > 0;
    if (busy) {
      const working = document.createElement('span');
      working.className = 'plugin-working';
      working.textContent = t('pluginWorking');
      header.append(working);
    } else if (!plugin.installed && gitFound && plugin.url) {
      header.append(button(t('installPlugin'), 'plugin-action', () => { void this.install(plugin); }));
    } else if (updatable) {
      header.append(button(t('updatePlugin'), 'plugin-action primary', () => { void this.run(plugin.name, () => updatePlugin(plugin.name)); }));
    }
    row.append(header);
    if (plugin.description) {
      const description = document.createElement('div');
      description.className = 'plugin-description';
      description.textContent = plugin.description;
      description.title = plugin.description;
      row.append(description);
    }
    const state = this.state(plugin);
    const canUse = plugin.installed && !busy && this.hooks.hasProject();
    if (state || canUse) {
      const footer = document.createElement('div');
      footer.className = 'plugin-footer';
      const line = document.createElement('span');
      line.className = `plugin-state${updatable ? ' update' : ''}`;
      line.textContent = state;
      footer.append(line);
      if (canUse) {
        footer.append(button(plugin.used ? t('removeFromProject') : t('addToProject'), 'plugin-link', () => { void this.use(plugin, !plugin.used); }));
      }
      row.append(footer);
    }
    return row;
  }

  // One line on where an installed plugin stands.
  private state(plugin: GlistPlugin): string {
    if (!plugin.installed) return '';
    const parts: string[] = [];
    if (plugin.used) parts.push(t('pluginInProject'));
    if (!plugin.official) parts.push(t('pluginNotOfficial'));
    else if (plugin.branch !== plugin.defaultBranch) parts.push(t('pluginOtherBranch').replace('{branch}', plugin.branch ?? 'HEAD'));
    else if ((plugin.behind ?? 0) > 0) parts.push(t('pluginBehind').replace('{count}', String(plugin.behind)));
    if ((plugin.changed ?? 0) > 0 || (plugin.ahead ?? 0) > 0) parts.push(t('pluginChanged'));
    return parts.join(' · ');
  }
}
