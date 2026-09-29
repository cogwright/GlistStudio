import { formDialog } from './git-dialogs';
import { icon, type IconName } from './icons';
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
export const updatePlugin = async ({ name, source = 'GlistPlugins' }: GlistPlugin): Promise<boolean> => {
  const from = (text: string): string => text.replace(/\{source\}/g, source);
  let result = await window.glistAPI.updatePlugin(name).catch((error: Error): GlistPluginResult => ({ success: false, message: error.message }));
  if (result.confirm) {
    const { changed, ahead } = result.confirm;
    const count = (one: TranslationKey, many: TranslationKey, value: number): string => from(value === 1 ? t(one) : t(many).replace('{count}', String(value)));
    const work = [
      ...(changed > 0 ? [count('pluginKeepFile', 'pluginKeepFiles', changed)] : []),
      ...(ahead > 0 ? [count('pluginKeepCommit', 'pluginKeepCommits', ahead)] : []),
    ].join(t('pluginKeepAnd'));
    const how = [...(changed > 0 ? [t('pluginKeepStash')] : []), ...(ahead > 0 ? [t('pluginKeepBranch')] : [])].join(t('pluginKeepAnd'));
    const answer = await formDialog({
      title: t('pluginKeepTitle').replace('{name}', name),
      hint: from(t('pluginKeepHint')).replace(/\{name\}/g, name).replace('{work}', work).replace('{how}', how),
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
    notify({ text: from(t('pluginUpdated')).replace('{name}', name), kind: 'success', ...(kept ? { detail: kept } : {}) });
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
        actions: [{ label: t('updatePlugins'), run: () => { void this.updateAll(outdated); } }],
      });
    };
    window.setTimeout(() => { void check(); }, 20000);
    window.setInterval(() => { void check(); }, checkEvery);
  }

  private async updateAll(plugins: GlistPlugin[]): Promise<void> {
    for (const plugin of plugins) await this.run(plugin.name, () => updatePlugin(plugin));
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

  // The name with the plugin's buttons at its right, each an icon and a word:
  // Install, Update, and Add to the project or, once added, Remove from it.
  // They move under the name when both do not fit beside it.
  private row(plugin: GlistPlugin, gitFound: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const busy = this.busy.has(plugin.name);
    const button = (iconName: IconName, label: string, title: string, className: string, run: () => void): HTMLButtonElement => {
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `plugin-action ${className}`;
      node.title = title;
      const text = document.createElement('span');
      text.textContent = label;
      node.append(icon(iconName), text);
      node.addEventListener('click', run);
      return node;
    };
    const header = document.createElement('div');
    header.className = 'plugin-header';
    const name = document.createElement('span');
    name.className = 'plugin-name';
    name.textContent = plugin.name;
    name.title = plugin.name;
    const actions = document.createElement('span');
    actions.className = 'plugin-actions';
    header.append(name, actions);
    const source = plugin.source ?? 'GlistPlugins';
    const updatable = plugin.installed && plugin.official && plugin.branch === plugin.defaultBranch && (plugin.behind ?? 0) > 0;
    if (busy) {
      const working = document.createElement('span');
      working.className = 'plugin-working';
      working.textContent = t('pluginWorking');
      actions.append(working);
    } else if (!plugin.installed) {
      if (gitFound && plugin.url) {
        actions.append(button('cloud-download', t('installPlugin'), t('installPluginTitle'), '', () => { void this.install(plugin); }));
      }
    } else {
      if (updatable) {
        actions.append(button('sync', t('updatePlugin'), t('updatePluginTitle').replace('{source}', source), 'primary', () => { void this.run(plugin.name, () => updatePlugin(plugin)); }));
      }
      if (this.hooks.hasProject()) {
        if (plugin.used) {
          // Added; pointing at it shows what a click does.
          const added = button('check', t('pluginAdded'), t('removeFromProject'), 'added', () => { void this.use(plugin, false); });
          const swap = (hover: boolean): void => {
            added.replaceChildren(icon(hover ? 'close' : 'check'), Object.assign(document.createElement('span'), { textContent: hover ? t('pluginRemove') : t('pluginAdded') }));
          };
          added.addEventListener('pointerenter', () => swap(true));
          added.addEventListener('pointerleave', () => swap(false));
          added.addEventListener('focus', () => swap(true));
          added.addEventListener('blur', () => swap(false));
          actions.append(added);
        } else {
          actions.append(button('add', t('pluginAdd'), t('addToProject'), '', () => { void this.use(plugin, true); }));
        }
      }
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
    if (state) {
      const line = document.createElement('div');
      line.className = `plugin-state${updatable ? ' update' : ''}`;
      line.textContent = state;
      row.append(line);
    }
    return row;
  }

  // One line on where an installed plugin stands, or where one listed from elsewhere comes from.
  private state(plugin: GlistPlugin): string {
    const source = plugin.source ?? 'GlistPlugins';
    if (!plugin.installed) return source.includes('/') ? t('pluginFrom').replace('{source}', source) : '';
    const parts: string[] = [];
    if (!plugin.official) parts.push(t('pluginNotOfficial').replace('{source}', source));
    else if (plugin.branch !== plugin.defaultBranch) parts.push(t('pluginOtherBranch').replace('{branch}', plugin.branch ?? 'HEAD'));
    else if ((plugin.behind ?? 0) > 0) parts.push(t('pluginBehind').replace('{count}', String(plugin.behind)).replace('{source}', source));
    if ((plugin.changed ?? 0) > 0 || (plugin.ahead ?? 0) > 0) parts.push(t('pluginChanged'));
    return parts.join(' · ');
  }
}
