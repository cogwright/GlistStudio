import { promises as fs } from 'node:fs';
import path from 'node:path';
import { githubRepository } from './git-protection';

// Where a Git checkout stands, read from its .git folder rather than by running
// git, which a student's computer may not have: the branch, the commit, and the
// commit's page when origin is on GitHub. For Settings > About.

export interface RepositoryHead {
  // Null when a commit is checked out rather than a branch.
  branch: string | null;
  // Null on a branch with no commits yet.
  commit: string | null;
  commitPage?: string;
}

const readText = (file: string): Promise<string | null> => fs.readFile(file, 'utf8').then((text) => text, (): null => null);

const isHash = (text: string | undefined): text is string => Boolean(text && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text));

// A worktree's or submodule's .git is a file naming the real folder.
const gitFolder = async (folder: string): Promise<string | null> => {
  const dotGit = path.join(folder, '.git');
  const stat = await fs.stat(dotGit).catch((): null => null);
  if (!stat) return null;
  if (stat.isDirectory()) return dotGit;
  const pointer = (await readText(dotGit))?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  return pointer ? path.resolve(folder, pointer) : null;
};

// A branch is a file of its own until git packs it into packed-refs.
const resolveRef = async (folders: string[], ref: string): Promise<string | null> => {
  for (const folder of folders) {
    const loose = (await readText(path.join(folder, ...ref.split('/'))))?.trim();
    if (isHash(loose)) return loose;
  }
  const packed = await readText(path.join(folders[folders.length - 1], 'packed-refs')) ?? '';
  const hash = packed.split('\n').map((line) => line.trim().split(' ')).find(([, name]) => name === ref)?.[0];
  return isHash(hash) ? hash : null;
};

const originUrl = (config: string): string | null => {
  const section = config.split(/^\s*\[/m).find((part) => /^remote\s+"origin"\s*\]/.test(part));
  return section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
};

// A commit's page, for a remote on GitHub in any of the forms git accepts.
export const githubCommitPage = (url: string, commit: string): string | undefined => {
  const repository = githubRepository(url);
  return repository ? `https://github.com/${repository}/commit/${commit}` : undefined;
};

export const readRepositoryHead = async (folder: string): Promise<RepositoryHead | null> => {
  const gitDir = await gitFolder(folder);
  const head = gitDir && (await readText(path.join(gitDir, 'HEAD')))?.trim();
  if (!gitDir || !head) return null;
  // A worktree keeps its HEAD apart and shares the rest with the main checkout.
  const common = (await readText(path.join(gitDir, 'commondir')))?.trim();
  const commonDir = common ? path.resolve(gitDir, common) : gitDir;
  const ref = head.match(/^ref:\s*(\S+)$/)?.[1];
  const commit = ref ? await resolveRef([gitDir, commonDir], ref) : isHash(head) ? head : null;
  const url = originUrl(await readText(path.join(commonDir, 'config')) ?? '');
  const commitPage = url && commit ? githubCommitPage(url, commit) : undefined;
  return {
    branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null,
    commit,
    ...(commitPage ? { commitPage } : {}),
  };
};
