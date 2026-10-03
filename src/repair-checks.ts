import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

// What Help > Repair IDE asks of a window's backend (studio.ts): what it is
// running, Git's locks left behind, and clangd's index. The window decides
// what to make of it (repair.ts).

export interface RepairContext {
  projectRoot(): string | null;
  dependencies(): Promise<GlistDependency[]>;
  // What builds get, with Git on PATH.
  environment(directory: string): NodeJS.ProcessEnv;
  processes(): Omit<GlistRepairState, 'project' | 'compileCommands'>;
  // The project's build folders, where compile_commands.json is written.
  buildFolders(projectRoot: string): string[];
  // Resolves once it has exited, so that it writes no more of its index.
  stopClangd(): Promise<void>;
}

// A lock git takes while it changes a repository, and removes when done.
// A git that crashed or was ended leaves it, and every git command after
// refuses to run. Older than a minute with no git running in the repository,
// it is left behind; a git commit waiting in an editor holds index.lock for
// as long as the editor is open, so a running git always keeps it.
export const lockAge = 60_000;
export const lockVerdict = (ageMs: number, gitRunning: boolean): 'stale' | 'recent' | 'busy' =>
  (gitRunning ? 'busy' : ageMs < lockAge ? 'recent' : 'stale');

const isInside = (folder: string, target: string): boolean => {
  const relative = path.relative(path.resolve(folder), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Whether a git is running in one of the folders. One whose folder cannot be
// told counts, as on Windows: a lock is only removed when nothing could hold it.
export const gitRunningIn = (processes: Array<{ cwd: string | null }>, folders: string[]): boolean =>
  processes.some(({ cwd }) => cwd === null || folders.some((folder) => isInside(folder, cwd)));

const output = (file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> => new Promise((resolve) => {
  execFile(file, args, { env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
});

// The git programs this user runs, each with the folder it runs in where the
// system says. Another user's git cannot have the user's repository open.
const gitProcesses = async (): Promise<Array<{ pid: number; cwd: string | null }>> => {
  const user = process.getuid?.() ?? -1;
  if (process.platform === 'win32') {
    const listed = await output('tasklist', ['/FI', 'IMAGENAME eq git.exe', '/FO', 'CSV', '/NH']) ?? '';
    return listed.split('\n').filter((line) => /^"git\.exe"/i.test(line)).map((line) => ({ pid: Number(line.split('","')[1]), cwd: null as string | null }));
  }
  if (process.platform === 'linux') {
    const found: Array<{ pid: number; cwd: string | null }> = [];
    for (const entry of await fs.readdir('/proc').catch((): string[] => [])) {
      if (!/^\d+$/.test(entry) || (await fs.readFile(`/proc/${entry}/comm`, 'utf8').catch(() => '')).trim() !== 'git') continue;
      if ((await fs.stat(`/proc/${entry}`).catch((): null => null))?.uid !== user) continue;
      found.push({ pid: Number(entry), cwd: await fs.readlink(`/proc/${entry}/cwd`).catch((): null => null) });
    }
    return found;
  }
  const listed = await output('ps', ['-U', String(user), '-o', 'pid=,comm=']) ?? '';
  const pids = listed.split('\n').map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter((match): match is RegExpExecArray => Boolean(match))
    .filter((match) => path.basename(match[2].trim()) === 'git').map((match) => Number(match[1]));
  if (pids.length === 0) return [];
  // lsof prints p<pid> then n<folder> for each.
  const folders = new Map<number, string>();
  let pid = 0;
  (await output('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]) ?? '').split('\n').forEach((line) => {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) folders.set(pid, line.slice(1));
  });
  return pids.map((each) => ({ pid: each, cwd: folders.get(each) ?? null }));
};

// The project's repository, the engine's and its plugins', each once.
const repositories = async (context: RepairContext): Promise<Array<{ name: string; top: string; gitDir: string }>> => {
  const root = context.projectRoot();
  if (!root) return [];
  const folders = [{ name: path.basename(root), folder: root },
    ...(await context.dependencies().catch((): GlistDependency[] => [])).filter((entry) => entry.exists).map((entry) => ({ name: entry.name, folder: entry.path }))];
  const found: Array<{ name: string; top: string; gitDir: string }> = [];
  for (const { name, folder } of folders) {
    const answer = await output('git', ['-C', folder, 'rev-parse', '--show-toplevel', '--absolute-git-dir'], context.environment(folder));
    const [top, gitDir] = (answer ?? '').trim().split('\n');
    if (top && gitDir && !found.some((each) => path.resolve(each.gitDir) === path.resolve(gitDir))) found.push({ name, top, gitDir });
  }
  return found;
};

const lockNames = ['index.lock', 'HEAD.lock'];

// Git's locks left behind in the open project's repositories, removed when
// fix is set; with git itself missing, only that.
const repairGit = async (context: RepairContext, fix: unknown): Promise<GlistRepairGit> => {
  const root = context.projectRoot();
  if (!root) return { installed: true, locks: [] };
  if (await output('git', ['--version'], context.environment(root)) === null) return { installed: false, locks: [] };
  const locks: GlistRepairLock[] = [];
  let running: Array<{ pid: number; cwd: string | null }> | null = null;
  for (const repository of await repositories(context)) {
    for (const name of lockNames) {
      const file = path.join(repository.gitDir, name);
      const stat = await fs.stat(file).catch((): null => null);
      if (!stat) continue;
      running ??= await gitProcesses();
      let verdict = lockVerdict(Date.now() - stat.mtimeMs, gitRunningIn(running, [repository.top, repository.gitDir]));
      // The studio's own git, reading the status a moment, would look the same: once more, a little later.
      if (verdict === 'busy') {
        await new Promise((resolve) => { setTimeout(resolve, 600); });
        running = await gitProcesses();
        verdict = lockVerdict(Date.now() - stat.mtimeMs, gitRunningIn(running, [repository.top, repository.gitDir]));
      }
      const entry = { repository: repository.name, file: name };
      if (verdict !== 'stale') locks.push({ ...entry, state: verdict });
      else if (fix !== true) locks.push({ ...entry, state: 'stale' });
      else {
        try {
          await fs.rm(file);
          locks.push({ ...entry, state: 'removed' });
        } catch (error) {
          locks.push({ ...entry, state: 'failed', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  return { installed: true, locks };
};

// Where clangd keeps its index of the project, the engine and the plugins
// with --background-index: beside the compile_commands.json it reads, in the
// build folder, and in the project's own folder when one is there.
export const clangdIndexFolders = (projectRoot: string, buildFolders: string[]): string[] =>
  [...buildFolders, projectRoot].map((folder) => path.join(folder, '.cache', 'clangd', 'index'));

// Stops clangd and deletes its index, which it builds again when the window
// starts it again. The folders deleted, as found.
const clearClangdIndex = async (context: RepairContext): Promise<string[]> => {
  const root = context.projectRoot();
  if (!root) return [];
  await context.stopClangd();
  const removed: string[] = [];
  for (const folder of clangdIndexFolders(root, context.buildFolders(root))) {
    if (!existsSync(folder)) continue;
    // Only ever inside the project, links followed.
    const real = await fs.realpath(folder).catch((): null => null);
    if (!real || !isInside(await fs.realpath(root), real)) continue;
    await fs.rm(real, { recursive: true, force: true });
    removed.push(folder);
  }
  return removed;
};

export const createRepairChecks = (context: RepairContext): {
  repairState(): GlistRepairState;
  repairGit(fix: unknown): Promise<GlistRepairGit>;
  clearClangdIndex(): Promise<string[]>;
} => ({
  repairState: () => {
    const root = context.projectRoot();
    return {
      ...context.processes(),
      project: root,
      compileCommands: Boolean(root) && context.buildFolders(root as string).some((folder) => existsSync(path.join(folder, 'compile_commands.json'))),
    };
  },
  repairGit: (fix) => repairGit(context, fix),
  clearClangdIndex: () => clearClangdIndex(context),
});
