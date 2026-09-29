import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pluginsInCmake, setPluginUsed } from './cmake';
import { githubRepository } from './git-protection';

// The Plugins view: the plugins GlistPlugins publishes, the ones installed in
// glistplugins beside the engine, installing one with git, and updating those
// that came from GlistPlugins. An update never loses work: files changed and
// not committed go to a stash, and commits of the user's own stay on a branch
// of their own, before the plugin moves to GlistPlugins' version.

export interface PluginContext {
  // The folder with GlistEngine, glistplugins and myglistapps.
  workspace(): string;
  // The open project's CMakeLists.txt, or null.
  projectCmake(): string | null;
  environment(): NodeJS.ProcessEnv;
  // GitHub's API, or a test server; and where GlistPlugins' repositories are cloned from.
  api?: string;
  site?: string;
  language(): 'en' | 'tr';
}

const messages = {
  en: {
    badName: 'This is not a plugin name.',
    notPublished: '{name} is not one of GlistPlugins\' plugins.',
    installedAlready: '{name} is already in glistplugins.',
    notFromGlistPlugins: '{name} was not installed from GlistPlugins, so it is not updated from there.',
    otherBranch: '{name} is on the branch {branch}; updates are for {main}.',
    noProject: 'Open a project first.',
    noPluginList: 'CMakeLists.txt has no set(PLUGINS ...) to add it to.',
  },
  tr: {
    badName: 'Bu bir eklenti adı değil.',
    notPublished: '{name}, GlistPlugins’in eklentilerinden biri değil.',
    installedAlready: '{name} zaten glistplugins içinde.',
    notFromGlistPlugins: '{name} GlistPlugins’ten kurulmadığı için oradan güncellenmez.',
    otherBranch: '{name} {branch} dalında; güncellemeler {main} dalı için.',
    noProject: 'Önce bir proje açın.',
    noPluginList: 'CMakeLists.txt içinde eklentinin ekleneceği bir set(PLUGINS ...) yok.',
  },
} as const;

const organization = 'GlistPlugins';
const listFor = 6 * 60 * 60 * 1000;

interface Repository { name: string; description: string; url: string; defaultBranch: string }

interface RunResult { code: number; stdout: string; stderr: string }

// A name as GitHub and a folder spell it, nothing that could pass for a path or an option.
const validName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name);

export const createPluginService = (context: PluginContext) => {
  const say = (key: keyof typeof messages.en, values: Record<string, string> = {}): string =>
    Object.entries(values).reduce((text: string, [name, value]) => text.replace(`{${name}}`, value), messages[context.language()][key]);
  const api = context.api ?? 'https://api.github.com';
  const site = context.site ?? 'https://github.com';
  let listed: { at: number; repositories: Repository[] } | null = null;

  const git = (args: string[], cwd: string): Promise<RunResult> => new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd, windowsHide: true,
      env: { ...context.environment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

  const pluginsFolder = (): string => path.join(context.workspace(), 'glistplugins');

  // GlistPlugins' repositories, asked for at most every six hours.
  const repositories = async (refresh: boolean): Promise<Repository[]> => {
    if (listed && !refresh && Date.now() - listed.at < listFor) return listed.repositories;
    const found: Repository[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const response = await fetch(`${api}/orgs/${organization}/repos?per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Glist Studio' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const batch = await response.json() as Array<{ name: string; description: string | null; html_url: string; default_branch: string; archived: boolean }>;
      batch.filter((entry) => !entry.archived && validName(entry.name)).forEach((entry) => found.push({
        name: entry.name, description: entry.description ?? '', url: entry.html_url, defaultBranch: entry.default_branch,
      }));
      if (batch.length < 100) break;
    }
    listed = { at: Date.now(), repositories: found.sort((a, b) => a.name.localeCompare(b.name)) };
    return listed.repositories;
  };

  const usedNames = async (): Promise<string[]> => {
    const file = context.projectCmake();
    if (!file) return [];
    return pluginsInCmake(await fs.readFile(file, 'utf8').catch(() => '')).map((name) => name.toLowerCase());
  };

  // What git says about an installed plugin: where it came from and how it differs.
  const inspect = async (folder: string, defaultBranch?: string): Promise<Partial<GlistPlugin>> => {
    if (!existsSync(path.join(folder, '.git'))) return { official: false, repository: false };
    const origin = (await git(['remote', 'get-url', 'origin'], folder)).stdout.trim();
    const official = githubRepository(origin)?.split('/')[0].toLowerCase() === organization.toLowerCase()
      || origin.toLowerCase().startsWith(`${site}/${organization}/`.toLowerCase());
    const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], folder)).stdout.trim() || null;
    const changed = (await git(['status', '--porcelain', '--untracked-files=normal'], folder)).stdout.split('\n').filter(Boolean).length;
    const main = defaultBranch ?? (await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], folder)).stdout.trim().replace(/^origin\//, '');
    let ahead = 0;
    let behind = 0;
    if (main && branch) {
      const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${main}`], folder)).stdout.trim().split(/\s+/);
      [ahead, behind] = counts.length === 2 ? counts.map(Number) : [0, 0];
    }
    return { repository: true, official, branch, defaultBranch: main || undefined, changed, ahead, behind };
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
      installed: installed.has(repository.name.toLowerCase()), used: used.includes(repository.name.toLowerCase()),
    }));
    // Installed ones GlistPlugins does not publish are listed too, as they are.
    installed.forEach((folder, key) => {
      if (!plugins.some((plugin) => plugin.name.toLowerCase() === key)) plugins.push({ name: folder, description: '', url: '', installed: true, used: used.includes(key) });
    });
    for (const plugin of plugins) {
      if (!plugin.installed) continue;
      const folder = path.join(pluginsFolder(), installed.get(plugin.name.toLowerCase()) ?? plugin.name);
      Object.assign(plugin, { folder }, gitFound ? await inspect(folder, plugin.defaultBranch) : {});
    }
    return { plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)), folder: pluginsFolder(), gitFound, ...(error ? { error } : {}) };
  };

  // Fetches GlistPlugins' version of every installed plugin that came from there.
  const checkPluginUpdates = async (): Promise<GlistPlugin[]> => {
    const list = await listPlugins();
    if (!list.gitFound) return [];
    const outdated: GlistPlugin[] = [];
    for (const plugin of list.plugins) {
      if (!plugin.folder || !plugin.official || !plugin.defaultBranch) continue;
      await git(['fetch', '--quiet', 'origin', plugin.defaultBranch], plugin.folder);
      Object.assign(plugin, await inspect(plugin.folder, plugin.defaultBranch));
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
    const result = await git(['clone', '--quiet', `${site}/${organization}/${repository.name}.git`, target], pluginsFolder());
    if (result.code !== 0) {
      await fs.rm(target, { recursive: true, force: true });
      return failed(result.stderr.trim().split('\n').pop() ?? `git clone stopped with code ${result.code}`);
    }
    return { success: true, message: repository.name };
  };

  // With keep false, an update that would put the user's work aside only says so.
  const updatePlugin = async (name: unknown, keep?: unknown): Promise<GlistPluginResult> => {
    if (!validName(name)) return failed(say('badName'));
    const plugin = (await listPlugins()).plugins.find((entry) => entry.name === name);
    if (!plugin?.folder || !plugin.official || !plugin.defaultBranch) return failed(say('notFromGlistPlugins', { name }));
    if (plugin.branch !== plugin.defaultBranch) return failed(say('otherBranch', { name, branch: plugin.branch ?? 'HEAD', main: plugin.defaultBranch }));
    const folder = plugin.folder;
    const fetched = await git(['fetch', '--quiet', 'origin', plugin.defaultBranch], folder);
    if (fetched.code !== 0) return failed(fetched.stderr.trim().split('\n').pop() ?? 'git fetch failed');
    const state = await inspect(folder, plugin.defaultBranch);
    const changed = state.changed ?? 0;
    const ahead = state.ahead ?? 0;
    if ((changed > 0 || ahead > 0) && keep !== true) return { success: false, message: '', confirm: { changed, ahead } };
    const kept: GlistPluginResult['kept'] = {};
    const target = `refs/remotes/origin/${plugin.defaultBranch}`;
    if (changed > 0) {
      const message = `Glist Studio: kept before updating ${name}`;
      const stashed = await git(['stash', 'push', '--include-untracked', '--message', message], folder);
      if (stashed.code !== 0) return failed(stashed.stderr.trim() || 'git stash failed');
      kept.stash = message;
    }
    if (ahead > 0) {
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
      const branch = `glist-studio/kept-${stamp}`;
      const saved = await git(['branch', branch, 'HEAD'], folder);
      if (saved.code !== 0) return failed(saved.stderr.trim() || 'git branch failed');
      kept.branch = branch;
      const reset = await git(['reset', '--hard', '--quiet', target], folder);
      if (reset.code !== 0) return failed(reset.stderr.trim() || 'git reset failed');
    } else {
      const merged = await git(['merge', '--ff-only', '--quiet', target], folder);
      if (merged.code !== 0) return failed(merged.stderr.trim() || 'git merge failed');
    }
    return { success: true, message: name, kept };
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
