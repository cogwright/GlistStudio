import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { githubRepository } from './git-protection';
import { languages, type Language, type Words } from './languages';

// Updating a copy of the engine or of a plugin from where it is published:
// GlistEngine/GlistEngine, GlistPlugins/<name>, or a plugin listed from
// elsewhere. The source may be any of the copy's remotes, such as upstream
// beside a fork. An update never loses work. Keeping it, the user's commits
// go on top of the new ones, or are merged with them once they were pushed to
// a protected branch, which a rebase would rewrite; changed files are put
// aside and back. Replacing it, the commits stay on a branch of their own and
// the changed files in a stash. Nothing here needs Electron.

export interface GitResult { code: number; stdout: string; stderr: string }
export type Git = (args: string[], cwd: string) => Promise<GitResult>;

export const gitRunner = (environment: () => NodeJS.ProcessEnv): Git => (args, cwd) => new Promise((resolve) => {
  const child = spawn('git', args, {
    cwd, windowsHide: true,
    env: { ...environment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true', LC_ALL: 'C' },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
  child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
});

export interface CheckoutContext {
  git: Git;
  // Where sources live besides GitHub: https://github.com, or a folder of repositories in tests.
  site: string;
  // Whether a remote's branch is protected, as Settings > Git and GitHub say.
  isProtected(folder: string, remote: string, branch: string): Promise<boolean>;
  language(): Language;
}

const lines = (result: GitResult): string[] => result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
const lastLine = (result: GitResult, fallback: string): string =>
  (result.stderr.trim() || result.stdout.trim()).split('\n').pop()?.trim() || fallback;
const separator = '\x1f';

// Whether a remote's address is the source's repository: owner/name on GitHub, or on the site.
export const isSourceAddress = (address: string, source: string, site = 'https://github.com'): boolean => {
  if (githubRepository(address)?.toLowerCase() === source.toLowerCase()) return true;
  const plain = (text: string): string => text.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '').replace(/\\/g, '/').toLowerCase();
  return plain(address) === plain(`${site}/${source}`);
};

export const createCheckouts = (context: CheckoutContext) => {
  const { git } = context;
  const say = (key: keyof Words['updates'], values: Record<string, string>): string =>
    Object.entries(values).reduce((text: string, [name, value]) => text.split(`{${name}}`).join(value), languages[context.language()].updates[key]);
  // Each source's default branch, once asked of the remote.
  const defaults = new Map<string, string>();

  const isCheckout = (folder: string): boolean => existsSync(path.join(folder, '.git'));

  // The remote whose address is the source, origin first.
  const sourceRemote = async (folder: string, source: string): Promise<string | null> => {
    const found = lines(await git(['config', '--get-regexp', '^remote\\..*\\.url$'], folder))
      .map((line) => { const at = line.indexOf(' '); return { name: line.slice('remote.'.length, at - '.url'.length), address: line.slice(at + 1) }; })
      .filter((remote) => isSourceAddress(remote.address, source, context.site))
      .map((remote) => remote.name);
    return found.includes('origin') ? 'origin' : found[0] ?? null;
  };

  // The source's default branch: as known, as the remote says when asked, as
  // the last fetch left it, or main or master as there.
  const defaultBranch = async (folder: string, remote: string, known: string | undefined, ask: boolean): Promise<string> => {
    if (known) return known;
    const key = `${folder}\n${remote}`;
    if (ask) {
      const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec((await git(['ls-remote', '--symref', remote, 'HEAD'], folder)).stdout);
      if (symref) defaults.set(key, symref[1]);
    }
    const remembered = defaults.get(key);
    if (remembered) return remembered;
    const head = (await git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], folder)).stdout.trim();
    if (head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
    for (const name of ['main', 'master']) {
      if ((await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], folder)).code === 0) return name;
    }
    return 'main';
  };

  // A remote branch that has the user's oldest commit of their own, and whether one that does is protected.
  const pushedTo = async (folder: string, target: string): Promise<{ ref?: string; protected: boolean }> => {
    const oldest = lines(await git(['rev-list', '--reverse', `${target}..HEAD`], folder))[0];
    if (!oldest) return { protected: false };
    const remotes = lines(await git(['remote'], folder)).sort((a, b) => b.length - a.length);
    const refs = lines(await git(['for-each-ref', '--contains', oldest, '--format=%(refname)', 'refs/remotes/'], folder))
      .map((ref) => ref.slice('refs/remotes/'.length)).filter((ref) => !ref.endsWith('/HEAD'));
    for (const ref of refs) {
      const remote = remotes.find((name) => ref.startsWith(`${name}/`));
      if (remote && await context.isProtected(folder, remote, ref.slice(remote.length + 1))) return { ref, protected: true };
    }
    return { ref: refs[0], protected: false };
  };

  // Where a copy stands against its source; fetching first when asked.
  const inspect = async (folder: string, source: string, options: { fetch?: boolean; defaultBranch?: string } = {}): Promise<GlistCheckout> => {
    if (!isCheckout(folder)) return { repository: false };
    const remote = await sourceRemote(folder, source);
    const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], folder)).stdout.trim() || null;
    const changed = lines(await git(['status', '--porcelain', '--untracked-files=normal'], folder)).length;
    const [hash, subject, date] = (await git(['log', '-1', `--format=%H${separator}%s${separator}%ct`, 'HEAD'], folder)).stdout.trim().split(separator);
    const head = hash ? { hash, subject: subject ?? '', date: Number(date) || 0 } : null;
    const state: GlistCheckout = { repository: true, remote, branch, head, changed, ahead: 0, behind: 0, incoming: [] };
    if (!remote) return state;
    const main = await defaultBranch(folder, remote, options.defaultBranch, options.fetch === true);
    state.defaultBranch = main;
    if (options.fetch) {
      const fetched = await git(['fetch', '--quiet', remote, main], folder);
      if (fetched.code !== 0) state.fetchError = lastLine(fetched, 'git fetch failed');
    }
    const target = `refs/remotes/${remote}/${main}`;
    if ((await git(['rev-parse', '--verify', '--quiet', target], folder)).code !== 0 || !head) return state;
    const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...${target}`], folder)).stdout.trim().split(/\s+/).map(Number);
    [state.ahead, state.behind] = counts.length === 2 ? counts : [0, 0];
    state.incoming = lines(await git(['log', `--format=%H${separator}%s`, '--max-count=20', `HEAD..${target}`], folder))
      .map((line) => { const [commit, text] = line.split(separator); return { hash: commit, subject: text ?? '' }; });
    state.keepBy = 'fast-forward';
    if ((state.ahead ?? 0) > 0) {
      const pushed = await pushedTo(folder, target);
      state.keepBy = pushed.protected ? 'merge' : 'rebase';
      if (pushed.ref) state.pushedTo = pushed.ref;
    }
    return state;
  };

  const failed = (message: string): GlistCheckoutResult => ({ success: false, message });

  // Brings the source's new commits in. With work of the user's own and no
  // choice, it only says what it would do; resolve leaves a conflict in place
  // for the Git tools instead of taking the update back.
  const update = async (
    folder: string, name: string, source: string, choice?: GlistUpdateChoice,
    options: { defaultBranch?: string; resolve?: boolean } = {},
  ): Promise<GlistCheckoutResult> => {
    const remote = isCheckout(folder) ? await sourceRemote(folder, source) : null;
    if (!remote) return failed(say('notFromSource', { name, source }));
    const state = await inspect(folder, source, { fetch: true, defaultBranch: options.defaultBranch });
    const main = state.defaultBranch ?? 'main';
    if (state.fetchError) return failed(state.fetchError);
    if (!state.branch) return failed(say('detached', { name }));
    if (state.branch !== main) return failed(say('otherBranch', { name, branch: state.branch, main }));
    if ((state.behind ?? 0) === 0) return { success: true, message: name, upToDate: true };
    const changed = state.changed ?? 0;
    const ahead = state.ahead ?? 0;
    const keepBy = state.keepBy ?? 'fast-forward';
    if ((changed > 0 || ahead > 0) && !choice) {
      return { success: false, message: '', confirm: { changed, ahead, keepBy, ...(state.pushedTo ? { pushedTo: state.pushedTo } : {}) } };
    }
    const target = `refs/remotes/${remote}/${main}`;
    if (choice === 'replace' && (changed > 0 || ahead > 0)) {
      const kept: GlistCheckoutResult['kept'] = {};
      if (changed > 0) {
        const message = `Glist Studio: kept before updating ${name}`;
        const stashed = await git(['stash', 'push', '--include-untracked', '--message', message], folder);
        if (stashed.code !== 0) return failed(lastLine(stashed, 'git stash failed'));
        kept.stash = message;
      }
      if (ahead > 0) {
        const stamp = new Date().toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
        const branch = `glist-studio/kept-${stamp}`;
        const saved = await git(['branch', branch, 'HEAD'], folder);
        if (saved.code !== 0) return failed(lastLine(saved, 'git branch failed'));
        kept.branch = branch;
      }
      const moved = await git(ahead > 0 ? ['reset', '--hard', '--quiet', target] : ['merge', '--ff-only', '--quiet', target], folder);
      if (moved.code !== 0) return failed(lastLine(moved, 'git reset failed'));
      return { success: true, message: name, how: 'replace', kept };
    }
    const how = ahead === 0 ? 'fast-forward' : keepBy;
    const args = how === 'fast-forward' ? ['merge', '--ff-only', '--autostash', target]
      : how === 'rebase' ? ['rebase', '--autostash', target]
        : ['merge', '--no-edit', '--autostash', target];
    const result = await git(args, folder);
    if (result.code !== 0) {
      const unmerged = lines(await git(['diff', '--name-only', '--diff-filter=U'], folder)).length > 0;
      const gitPath = async (name: string): Promise<string> => path.resolve(folder, (await git(['rev-parse', '--git-path', name], folder)).stdout.trim());
      const stopped = existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply')) || existsSync(await gitPath('MERGE_HEAD'));
      if (unmerged || stopped) {
        // Taken back, the copy is as it was, the changed files too.
        if (!options.resolve) await git([how === 'rebase' ? 'rebase' : 'merge', '--abort'], folder);
        return { success: false, message: say('conflicts', { name, source }), conflicts: true, how };
      }
      return failed(lastLine(result, `git ${args[0]} failed`));
    }
    // Put back, the changed files clashed with the new version; git keeps them in a stash.
    const stashClash = /Applying autostash resulted in conflicts|Your changes are safe in the stash/i.test(`${result.stdout}\n${result.stderr}`);
    return { success: true, message: name, how, ...(stashClash ? { stashClash: true } : {}) };
  };

  return { inspect, update, sourceRemote };
};
