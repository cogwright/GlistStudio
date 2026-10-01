import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createCheckouts, gitMessage, gitRunner } from './checkout-update';
import { pluginsInCmake, setPluginUsed } from './cmake';
import { defaultProtection, matchesBranch } from './git-protection';
import { languages, type Language, type Words } from './languages';

// The Plugins view: the plugins GlistPlugins publishes, the ones installed in
// glistplugins beside the engine, installing one with git, and updating those
// whose remotes include where they are published, the way the engine is
// updated (checkout-update.ts).

export interface PluginContext {
  // The folder with GlistEngine, glistplugins and myglistapps.
  workspace(): string;
  // The open project's CMakeLists.txt, or null.
  projectCmake(): string | null;
  environment(): NodeJS.ProcessEnv;
  // GitHub's API, or a test server; and where GlistPlugins' repositories are cloned from.
  api?: string;
  site?: string;
  language(): Language;
  // Tests list their own; see extraRepositories and hiddenPlugins.
  extras?: string[];
  hidden?: string[];
  // Whether a remote's branch is protected; by default main and master are.
  isProtected?(folder: string, remote: string, branch: string): Promise<boolean>;
  // The Git console, for the commands that change a plugin's copy.
  report?(entry: GlistGitConsoleEntry): void;
}

const organization = 'GlistPlugins';

// Plugins published elsewhere, listed with GlistPlugins' own, as owner/name;
// GitHub describes them as it does the others.
const extraRepositories = ['aitial/OpenWhiz'];

// Plugins left out of the list: gipDebug only carries GDB for Eclipse, and the
// studio installs a debugger of its own.
const hiddenPlugins = ['gipDebug'];
const listFor = 6 * 60 * 60 * 1000;

// owner: GlistPlugins, or the owner of one listed from elsewhere, as GitHub spells it.
interface Repository { name: string; description: string; url: string; defaultBranch: string; owner: string; extra: boolean }

// A name as GitHub and a folder spell it, nothing that could pass for a path or an option.
const validName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name);

export const createPluginService = (context: PluginContext) => {
  const say = (key: keyof Words['plugins'], values: Record<string, string> = {}): string =>
    Object.entries(values).reduce((text: string, [name, value]) => text.replace(`{${name}}`, value), languages[context.language()].plugins[key]);
  const extras = context.extras ?? extraRepositories;
  const hidden = new Set((context.hidden ?? hiddenPlugins).map((name) => name.toLowerCase()));
  const api = context.api ?? 'https://api.github.com';
  const site = context.site ?? 'https://github.com';
  let listed: { at: number; repositories: Repository[] } | null = null;
  const git = gitRunner(context.environment, context.report);
  const checkouts = createCheckouts({
    git,
    site,
    isProtected: context.isProtected ?? (async (_folder, _remote, branch) => matchesBranch(branch, defaultProtection.branches)),
    language: context.language,
  });

  const pluginsFolder = (): string => path.join(context.workspace(), 'glistplugins');

  type GitHubRepository = { name: string; full_name: string; description: string | null; html_url: string; default_branch: string; archived: boolean };
  const ask = async (address: string): Promise<unknown> => {
    const response = await fetch(`${api}/${address}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Glist Studio' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    return response.json();
  };
  const described = (entry: GitHubRepository, extra: boolean): Repository => ({
    name: entry.name, description: entry.description ?? '', url: entry.html_url, defaultBranch: entry.default_branch,
    owner: entry.full_name.split('/')[0], extra,
  });

  // GlistPlugins' repositories and the ones listed from elsewhere, asked for at most every six hours.
  const repositories = async (refresh: boolean): Promise<Repository[]> => {
    if (listed && !refresh && Date.now() - listed.at < listFor) return listed.repositories;
    const found: Repository[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await ask(`orgs/${organization}/repos?per_page=100&page=${page}`) as GitHubRepository[];
      batch.filter((entry) => !entry.archived && validName(entry.name)).forEach((entry) => found.push(described(entry, false)));
      if (batch.length < 100) break;
    }
    // One that cannot be read now is only left out, not the list with it.
    for (const extra of extras) {
      const entry = await (ask(`repos/${extra}`) as Promise<GitHubRepository>).catch((): null => null);
      if (entry && !entry.archived && validName(entry.name) && !found.some((known) => known.name.toLowerCase() === entry.name.toLowerCase())) found.push(described(entry, true));
    }
    const shown = found.filter((entry) => !hidden.has(entry.name.toLowerCase()));
    listed = { at: Date.now(), repositories: shown.sort((a, b) => a.name.localeCompare(b.name)) };
    return listed.repositories;
  };

  // How the list names where a plugin comes from: GlistPlugins, or owner/name for one from elsewhere.
  const sourceOf = (repository: Repository): string => (repository.extra ? `${repository.owner}/${repository.name}` : organization);

  const usedNames = async (): Promise<string[]> => {
    const file = context.projectCmake();
    if (!file) return [];
    return pluginsInCmake(await fs.readFile(file, 'utf8').catch(() => '')).map((name) => name.toLowerCase());
  };

  // The repository a plugin is published in, as owner/name.
  const repositoryOf = (plugin: Pick<GlistPlugin, 'name' | 'source'>): string =>
    (plugin.source?.includes('/') ? plugin.source : `${organization}/${plugin.name}`);

  // An installed plugin against where it is published, fetching first when asked.
  const inspect = async (plugin: GlistPlugin, fetch = false): Promise<Partial<GlistPlugin>> => {
    const state = await checkouts.inspect(plugin.folder ?? '', repositoryOf(plugin), { fetch, defaultBranch: plugin.defaultBranch });
    return { ...state, official: Boolean(state.remote) };
  };

  const listPlugins = async (refresh?: unknown): Promise<GlistPluginList> => {
    const gitFound = (await git(['--version'], homedir())).code === 0;
    let available: Repository[] = [];
    let error: string | undefined;
    try { available = await repositories(refresh === true); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const folders = await fs.readdir(pluginsFolder(), { withFileTypes: true }).catch((): Array<{ name: string; isDirectory(): boolean }> => []);
    const installed = new Map(folders.filter((entry) => entry.isDirectory() && validName(entry.name)).map((entry) => [entry.name.toLowerCase(), entry.name]));
    const used = await usedNames();
    const plugins: GlistPlugin[] = available.map((repository) => ({
      name: repository.name, description: repository.description, url: repository.url, defaultBranch: repository.defaultBranch,
      source: sourceOf(repository), installed: installed.has(repository.name.toLowerCase()), used: used.includes(repository.name.toLowerCase()),
    }));
    // Installed ones the list does not have are shown too, as they are, but hidden ones stay hidden.
    installed.forEach((folder, key) => {
      if (hidden.has(key) || plugins.some((plugin) => plugin.name.toLowerCase() === key)) return;
      plugins.push({ name: folder, description: '', url: '', source: organization, installed: true, used: used.includes(key) });
    });
    for (const plugin of plugins) {
      if (!plugin.installed) continue;
      plugin.folder = path.join(pluginsFolder(), installed.get(plugin.name.toLowerCase()) ?? plugin.name);
      if (gitFound) Object.assign(plugin, await inspect(plugin));
    }
    return { plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)), folder: pluginsFolder(), gitFound, ...(error ? { error } : {}) };
  };

  // Fetches the new commits of every installed plugin that has its source as a remote.
  const checkPluginUpdates = async (): Promise<GlistPlugin[]> => {
    const list = await listPlugins();
    if (!list.gitFound) return [];
    const outdated: GlistPlugin[] = [];
    for (const plugin of list.plugins) {
      if (!plugin.folder || !plugin.official) continue;
      Object.assign(plugin, await inspect(plugin, true));
      if ((plugin.behind ?? 0) > 0 && plugin.branch === plugin.defaultBranch) outdated.push(plugin);
    }
    return outdated;
  };

  const failed = (message: string): GlistPluginResult => ({ success: false, message });

  const installPlugin = async (name: unknown): Promise<GlistPluginResult> => {
    if (!validName(name)) return failed(say('badName'));
    const repository = (await repositories(false)).find((entry) => entry.name === name);
    if (!repository) return failed(say('notPublished', { name }));
    const target = path.join(pluginsFolder(), repository.name);
    if (existsSync(target)) return failed(say('installedAlready', { name: repository.name }));
    await fs.mkdir(pluginsFolder(), { recursive: true });
    const result = await git(['clone', '--quiet', `${site}/${repository.owner}/${repository.name}.git`, target], pluginsFolder(), true);
    if (result.code !== 0) {
      await fs.rm(target, { recursive: true, force: true });
      return failed(gitMessage(result, `git clone stopped with code ${result.code}`));
    }
    return { success: true, message: repository.name };
  };

  // Without a choice, an update that would touch the user's work only says so.
  const updatePlugin = async (name: unknown, choice?: unknown, resolve?: unknown): Promise<GlistCheckoutResult> => {
    if (!validName(name)) return failed(say('badName'));
    const plugin = (await listPlugins()).plugins.find((entry) => entry.name === name);
    if (!plugin?.folder) return failed(say('notPublished', { name }));
    return checkouts.update(plugin.folder, plugin.name, repositoryOf(plugin),
      choice === 'keep' || choice === 'replace' ? choice : undefined, { defaultBranch: plugin.defaultBranch, resolve: resolve === true });
  };

  // Adds an installed plugin to the open project's PLUGINS, or takes it out.
  const usePlugin = async (name: unknown, use: unknown): Promise<GlistPluginResult> => {
    if (!validName(name)) return failed(say('badName'));
    const file = context.projectCmake();
    if (!file) return failed(say('noProject'));
    const cmake = await fs.readFile(file, 'utf8');
    const next = setPluginUsed(cmake, name, use === true);
    if (next === null) return failed(say('noPluginList'));
    if (next !== cmake) await fs.writeFile(file, next, 'utf8');
    return { success: true, message: name };
  };

  return { listPlugins, checkPluginUpdates, installPlugin, updatePlugin, usePlugin };
};
