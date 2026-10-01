import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync, watch, type Dirent, type FSWatcher } from 'node:fs';
import { availableParallelism, homedir, release, type, userInfo } from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { agentLaunch, findAgents, installAgent, isAgentId, type AgentPlaces, type AgentStatus } from './agents';
import type { Handlers } from './api';
import { findDebugAdapter } from './debug-adapters';
import { debuggerRelease, installDebugger, installedDebugger, removeDebugger } from './debugger-download';
import { MessageProcess } from './message-process';
import { renderCppClass } from './class-template';
import { codeStyleFor } from './code-style';
import { cmakeInputs, pluginsInCmake, synchronizeCmake, type CmakeChange } from './cmake';
import { filesIn, searchFolders, type SearchFolder } from './file-search';
import { createGitService } from './git-service';
import { createCheckouts, gitRunner } from './checkout-update';
import { isLanguage, languages, type Language, type Words } from './languages';
import { createPluginService } from './plugins';
import { readRepositoryHead, type RepositoryHead } from './repository-head';
import { queryPattern } from './text-search';

// What the backend needs from whoever hosts it: the Electron main process or
// the browser preview server.
export interface StudioHost {
  send(channel: string, payload: unknown): void;
  trashItem(entryPath: string): Promise<void>;
  showItemInFolder(entryPath: string): void;
  openPath(entryPath: string): Promise<unknown>;
  templateRoot: string;
  // Where new projects go when no open project points at a workspace.
  projectsDirectory: string;
  version: string;
  // The commit Glist Studio was built from, for Settings > About.
  studioHead(): Promise<RepositoryHead | null>;
}

// The folder the Glist install scripts set up: the engine, zbin and myglistapps.
export const glistRoot = (): string => (process.platform === 'win32'
  ? 'C:\\dev\\glist' : path.join(homedir(), 'dev', 'glist'));

// The myglistapps folder of a default Glist install.
export const defaultProjectsDirectory = (): string => path.join(glistRoot(), 'myglistapps');

// Glist Studio's own folder in the Glist one: its settings, and the agents and
// the Node.js runtime Settings installs. GLIST_STUDIO_HOME moves it, for tests.
export const studioHome = (): string => (process.env.GLIST_STUDIO_HOME
  ? path.resolve(process.env.GLIST_STUDIO_HOME) : path.join(glistRoot(), 'GlistStudio'));

const currentUsername = (): string => {
  const environmentUsername = process.env.USERNAME || process.env.USER;
  if (environmentUsername) return environmentUsername;
  return userInfo().username;
};

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface Toolchain {
  cmake: string;
  toolBin?: string;
  generator?: string;
  // Where the project's plugins keep their DLLs, for Windows to find them.
  pluginBins?: string[];
}

interface ProcessResult {
  success: boolean;
  message: string;
}

type ProjectTemplate = 'GlistApp' | 'GlistConsoleApp' | 'GlistGUIApp';

const templateNames = new Set<ProjectTemplate>(['GlistApp', 'GlistConsoleApp', 'GlistGUIApp']);
let language: Language = 'en';

export const msg = (key: keyof Words['studio']): string => languages[language].studio[key];

const ignoredDirectories = new Set([
  '.git', '.webpack', 'node_modules', 'out', 'build',
]);

let host: StudioHost;
let activeProjectRoot: string | null = null;
let buildProcess: ChildProcessWithoutNullStreams | null = null;
let runProcess: ChildProcessWithoutNullStreams | null = null;

export const initializeStudio = (studioHost: StudioHost): void => { host = studioHost; };

const sendToRenderer = (channel: string, payload: unknown): void => host.send(channel, payload);

const requireProjectRoot = (): string => {
  if (!activeProjectRoot) throw new Error(msg('noProject'));
  return activeProjectRoot;
};

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const assertPathInProject = (candidatePath: string): string => {
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isInside(path.resolve(requireProjectRoot()), resolvedCandidate)) {
    throw new Error(msg('outsideProject'));
  }
  return resolvedCandidate;
};

const assertExistingPathInProject = async (candidatePath: string): Promise<string> => {
  const safePath = assertPathInProject(candidatePath);
  const realRoot = await fs.realpath(requireProjectRoot());
  if (!isInside(realRoot, await fs.realpath(safePath))) throw new Error(msg('outsideProject'));
  return safePath;
};

const listDirectory = async (directoryPath: string): Promise<FileEntry[]> =>
  listEntries(await assertExistingPathInProject(directoryPath), directoryPath);

const listEntries = async (safeDirectory: string, directoryPath: string): Promise<FileEntry[]> => {
  const entries = await fs.readdir(safeDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory() || !ignoredDirectories.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: path.join(directoryPath, entry.name),
      isDirectory: entry.isDirectory(),
    }))
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
    });
};

const validateEntryName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error(msg('invalidName'));
  }
  return trimmed;
};

const resolveNewEntryPath = async (directoryPath: string, name: string): Promise<string> => {
  const safeDirectory = await assertExistingPathInProject(directoryPath);
  const stats = await fs.stat(safeDirectory);
  if (!stats.isDirectory()) throw new Error(msg('folderRequired'));
  return assertPathInProject(path.join(safeDirectory, validateEntryName(name)));
};

const relativeProjectPath = (filePath: string): string =>
  path.relative(requireProjectRoot(), filePath).replace(/\\/g, '/');

const cmakeChange = async (change: CmakeChange): Promise<{
  path: string; before: string; after: string;
} | null> => {
  const cmakePath = path.join(requireProjectRoot(), 'CMakeLists.txt');
  if (!existsSync(cmakePath)) return null;
  const before = await fs.readFile(cmakePath, 'utf8');
  const after = synchronizeCmake(before, change, process.platform === 'linux');
  return { path: cmakePath, before, after };
};

const writeCmakeChange = async (change: Awaited<ReturnType<typeof cmakeChange>>): Promise<void> => {
  if (change && change.after !== change.before) await fs.writeFile(change.path, change.after, 'utf8');
};

const createProjectFile = async (directoryPath: string, name: string): Promise<string> => {
  const filePath = await resolveNewEntryPath(directoryPath, name);
  const change = await cmakeChange({ kind: 'add', paths: [relativeProjectPath(filePath)] });
  await fs.writeFile(filePath, '', { encoding: 'utf8', flag: 'wx' });
  try { await writeCmakeChange(change); }
  catch (error) { await fs.rm(filePath, { force: true }); throw error; }
  return filePath;
};

const createProjectDirectory = async (directoryPath: string, name: string): Promise<string> => {
  const newDirectoryPath = await resolveNewEntryPath(directoryPath, name);
  await fs.mkdir(newDirectoryPath);
  return newDirectoryPath;
};

const deleteProjectEntry = async (entryPath: string): Promise<boolean> => {
  const safePath = await assertExistingPathInProject(entryPath);
  if (safePath === path.resolve(requireProjectRoot())) {
    throw new Error(msg('rootDelete'));
  }
  const change = safePath === path.join(requireProjectRoot(), 'CMakeLists.txt')
    ? null : await cmakeChange({ kind: 'remove', path: relativeProjectPath(safePath) });
  await writeCmakeChange(change);
  try { await host.trashItem(safePath); }
  catch (error) {
    if (change && change.after !== change.before) await fs.writeFile(change.path, change.before, 'utf8');
    throw error;
  }
  return true;
};

const sameFile = async (left: string, right: string): Promise<boolean> => {
  const [leftStats, rightStats] = await Promise.all([fs.stat(left), fs.stat(right)]);
  return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
};

const renameProjectEntry = async (entryPath: string, newName: string): Promise<string> => {
  const oldPath = await assertExistingPathInProject(entryPath);
  if (oldPath === path.resolve(requireProjectRoot())) throw new Error(msg('rootDelete'));
  const nextPath = assertPathInProject(path.join(path.dirname(oldPath), validateEntryName(newName)));
  if (oldPath === nextPath) return oldPath;
  // On file systems that ignore case, renaming foo.h to Foo.h finds itself.
  if (existsSync(nextPath) && !(await sameFile(oldPath, nextPath))) throw new Error(msg('alreadyExists'));
  const change = oldPath === path.join(requireProjectRoot(), 'CMakeLists.txt')
    ? null : await cmakeChange({ kind: 'rename', from: relativeProjectPath(oldPath), to: relativeProjectPath(nextPath) });
  await fs.rename(oldPath, nextPath);
  if (change) {
    try { await writeCmakeChange(change); }
    catch (error) { await fs.rename(nextPath, oldPath); throw error; }
  }
  return nextPath;
};

const createCppClass = async (directoryPath: string, className: string): Promise<{ header: string; source: string }> => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(className)) throw new Error(msg('invalidClass'));
  const header = await resolveNewEntryPath(directoryPath, `${className}.h`);
  const source = await resolveNewEntryPath(directoryPath, `${className}.cpp`);
  if (existsSync(header) || existsSync(source)) throw new Error(msg('alreadyExists'));
  const change = await cmakeChange({ kind: 'add', paths: [relativeProjectPath(source), relativeProjectPath(header)] });
  if (!change || change.after === change.before) throw new Error(msg('classSource'));
  const { headerContent, sourceContent } = renderCppClass(
    className, relativeProjectPath(header), currentUsername(), new Date(),
  );
  await fs.writeFile(header, headerContent, { flag: 'wx' });
  try {
    await fs.writeFile(source, sourceContent, { flag: 'wx' });
    await writeCmakeChange(change);
  } catch (error) {
    await fs.rm(header, { force: true });
    await fs.rm(source, { force: true });
    await fs.writeFile(change.path, change.before, 'utf8');
    throw error;
  }
  return { header, source };
};

// Where an item named so goes in a folder: under its own name, or "name - Copy",
// "name - Copy 2" and so on when the name is taken.
const freeTarget = (destination: string, originalName: string, isDirectory: boolean): string => {
  const parsed = path.parse(originalName);
  let target = path.join(destination, originalName);
  for (let index = 1; existsSync(target); index += 1) {
    const copy = ` - Copy${index > 1 ? ` ${index}` : ''}`;
    target = path.join(destination, isDirectory ? `${originalName}${copy}` : `${parsed.name}${copy}${parsed.ext}`);
  }
  return target;
};

// A folder is not copied into itself or a folder inside it.
const assertNotIntoSelf = (source: string, destination: string): void => {
  const relative = path.relative(source, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(msg('copyIntoSelf'));
  }
};

const projectFolder = async (directoryPath: unknown): Promise<string> => {
  if (typeof directoryPath !== 'string') throw new Error(msg('folderRequired'));
  const folder = await assertExistingPathInProject(directoryPath);
  if (!(await fs.stat(folder)).isDirectory()) throw new Error(msg('folderRequired'));
  return folder;
};

const copyProjectEntry = async (entryPath: string, destinationDirectory: string): Promise<string> => {
  const source = await assertExistingPathInProject(entryPath);
  const destination = await projectFolder(destinationDirectory);
  const sourceStats = await fs.stat(source);
  if (sourceStats.isDirectory()) assertNotIntoSelf(source, destination);
  const target = freeTarget(destination, path.basename(source), sourceStats.isDirectory());
  await fs.cp(source, target, { recursive: sourceStats.isDirectory(), force: false, errorOnExist: true });
  return target;
};

// Files and folders dragged in from the system's file manager, copied into a
// project folder. They come from anywhere on the computer: the user chose them.
const importPaths = async (sources: unknown, destinationDirectory: unknown): Promise<string[]> => {
  const destination = await projectFolder(destinationDirectory);
  const copied: string[] = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) continue;
    const stats = await fs.stat(source);
    if (stats.isDirectory()) assertNotIntoSelf(source, destination);
    const target = freeTarget(destination, path.basename(source), stats.isDirectory());
    await fs.cp(source, target, { recursive: stats.isDirectory(), force: false, errorOnExist: true });
    copied.push(target);
  }
  return copied;
};

// The same from a browser, which gives no paths: each file's place in what was
// dropped, such as sprites/hero.png, and its bytes in base64. A dropped folder
// whose name is taken is renamed as a whole.
const importFiles = async (destinationDirectory: unknown, files: unknown): Promise<string[]> => {
  const destination = await projectFolder(destinationDirectory);
  const tops = new Map<string, string>();
  for (const file of Array.isArray(files) ? files : []) {
    const { path: place, data } = (file ?? {}) as { path?: unknown; data?: unknown };
    if (typeof place !== 'string' || typeof data !== 'string') continue;
    const parts = place.split('/').filter(Boolean).map(validateEntryName);
    if (parts.length === 0) continue;
    let top = tops.get(parts[0]);
    if (!top) {
      top = freeTarget(destination, parts[0], parts.length > 1);
      tops.set(parts[0], top);
    }
    const target = assertPathInProject(path.join(top, ...parts.slice(1)));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(data, 'base64'), { flag: 'wx' });
  }
  return [...tops.values()];
};

const showInSystemExplorer = async (entryPath: string): Promise<void> => {
  const safePath = await assertExistingPathInProject(entryPath);
  if (safePath === path.resolve(requireProjectRoot())) await host.openPath(safePath);
  else host.showItemInFolder(safePath);
};

// Linux has no single terminal; $TERMINAL is how tiling setups name theirs.
const terminals = (directory: string): Array<[string, string[]]> => {
  if (process.platform === 'win32') return [['cmd.exe', ['/K']]];
  if (process.platform === 'darwin') return [['open', ['-a', 'Terminal', directory]]];
  return [process.env.TERMINAL, 'x-terminal-emulator', 'gnome-terminal', 'konsole', 'kitty', 'alacritty', 'foot', 'xterm']
    .filter((command): command is string => Boolean(command))
    .map((command): [string, string[]] => [command, []]);
};

const openCommandPrompt = async (entryPath: string): Promise<void> => {
  const safePath = await assertExistingPathInProject(entryPath);
  const directory = (await fs.stat(safePath)).isDirectory() ? safePath : path.dirname(safePath);
  for (const [command, args] of terminals(directory)) {
    const child = spawn(command, args, { cwd: directory, detached: true, stdio: 'ignore', windowsHide: false });
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (started) { child.unref(); return; }
  }
  throw new Error(msg('terminalMissing'));
};

const createProjectFromTemplate = async (
  templateName: ProjectTemplate,
  projectName: string,
): Promise<{ root: string; name: string; hasCMakeProject: boolean }> => {
  if (!templateNames.has(templateName)) throw new Error(msg('invalidTemplate'));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(projectName)) throw new Error(msg('invalidName'));
  const source = path.join(host.templateRoot, templateName);
  const directory = projectsDirectory();
  const target = path.join(directory, projectName);
  if (existsSync(target)) throw new Error(msg('projectExists'));
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false, errorOnExist: true });
  const eclipsePath = path.join(target, '.project');
  if (existsSync(eclipsePath)) {
    const eclipse = await fs.readFile(eclipsePath, 'utf8');
    await fs.writeFile(eclipsePath, eclipse.replace(/<name>[^<]+<\/name>/, `<name>${projectName}</name>`), 'utf8');
  }
  activeProjectRoot = target;
  chosenTarget = null;
  runArguments = [];
  await rememberProject(target).catch((): undefined => undefined);
  void git.projectChanged();
  void rememberConfiguration(target);
  return { root: target, name: projectName, hasCMakeProject: true };
};

const findAncestorWith = (projectRoot: string, marker: string): string | null => {
  let cursor = path.resolve(projectRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(path.join(cursor, marker))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
};

// A project builds only from <workspace>/myglistapps, since the template reaches
// the engine through ../../GlistEngine. Prefer the workspace of the open project.
export const projectsDirectory = (): string => {
  const workspaceRoot = activeProjectRoot && findAncestorWith(activeProjectRoot, path.join('GlistEngine', 'engine'));
  return workspaceRoot ? path.join(workspaceRoot, 'myglistapps') : host.projectsDirectory;
};

// The folders the plugins a project names keep their DLLs in: libs\bin and
// prebuilts\bin. Plugins that do not copy their DLLs next to the app ask, in
// their READMEs, for these to go on the app's PATH in Eclipse; here that is done
// for them.
export const pluginDllFolders = (projectRoot: string): string[] => {
  let cmake = '';
  try { cmake = readFileSync(path.join(projectRoot, 'CMakeLists.txt'), 'utf8'); } catch { return []; }
  const workspaceRoot = findAncestorWith(projectRoot, path.join('GlistEngine', 'engine')) ?? path.resolve(projectRoot, '..', '..');
  return pluginsInCmake(cmake).flatMap((name) => ['libs', 'prebuilts']
    .map((folder) => path.join(workspaceRoot, 'glistplugins', name, folder, 'bin'))
    .filter((folder) => existsSync(folder)));
};

const resolveToolchain = (projectRoot: string): Toolchain => {
  if (process.platform !== 'win32') return { cmake: 'cmake' };
  const pluginBins = pluginDllFolders(projectRoot);
  const workspaceRoot = findAncestorWith(projectRoot, path.join('zbin', 'glistzbin-win64', 'CMake', 'bin', 'cmake.exe'));
  if (!workspaceRoot) return { cmake: 'cmake', generator: 'MinGW Makefiles', pluginBins };
  const distributionRoot = path.join(workspaceRoot, 'zbin', 'glistzbin-win64');
  return {
    cmake: path.join(distributionRoot, 'CMake', 'bin', 'cmake.exe'),
    toolBin: path.join(distributionRoot, 'clang64', 'bin'),
    generator: 'MinGW Makefiles',
    pluginBins,
  };
};

// Folders added in Settings > PATH.
let customPath: string[] = [];

// The PATH Glist Studio itself was started with. Only finding agents and the
// Glist installer use it; everything else gets pathFor's.
export const osPath = (): string => Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';

// Xcode's tools, where xcode-select points: the command line tools or an Xcode.
let xcodeFolders: string[] | null = null;
const xcodeTools = (): string[] => {
  if (xcodeFolders) return xcodeFolders;
  let developer = '';
  try { developer = execFileSync('xcode-select', ['-p'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { /* No Xcode tools. */ }
  xcodeFolders = developer ? [path.join(developer, 'usr', 'bin'), path.join(developer, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin')] : [];
  return xcodeFolders;
};

// This computer's own folders the studio's programs need, rather than whatever
// PATH the studio was started with: on macOS, Homebrew's, the system's and
// Xcode's; on Linux, the system's; on Windows, Windows' own, since Glist's
// tools come from zbin.
export const systemFolders = (): string[] => {
  let folders: string[];
  if (process.platform === 'win32') {
    const windows = process.env.SystemRoot ?? 'C:\\Windows';
    const system = path.join(windows, 'System32');
    folders = [system, windows, path.join(system, 'Wbem'), path.join(system, 'WindowsPowerShell', 'v1.0'), path.join(system, 'OpenSSH')];
  } else if (process.platform === 'darwin') {
    folders = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/System/Cryptexes/App/usr/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...xcodeTools()];
  } else {
    folders = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin'];
  }
  return folders.filter((folder) => existsSync(folder));
};

// Git for Windows, which is not in zbin: where the computer's PATH has it, or where it installs.
let gitFolderFound: string | null | undefined;
const windowsGitFolder = (): string | null => {
  if (gitFolderFound !== undefined) return gitFolderFound;
  const places = [...osPath().split(path.delimiter), path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd')];
  gitFolderFound = places.find((folder) => folder && existsSync(path.join(folder, 'git.exe'))) ?? null;
  return gitFolderFound;
};

// PATH for builds, clangd, the debugger, the app and the terminal, entry by
// entry with where each comes from; Settings > PATH shows the same list. Plugin
// folders go after this computer's own, as their READMEs say: some carry their
// own copies of the compiler's runtime DLLs, such as gipDebug's libstdc++, which
// must not come before Glist's. Folders added in Settings come last of all.
const pathFor = (toolchain: Toolchain): GlistPathEntry[] => {
  const cmakeBin = path.isAbsolute(toolchain.cmake) ? path.dirname(toolchain.cmake) : undefined;
  const entry = (folder: string, source: GlistPathEntry['source'], owner = ''): GlistPathEntry => ({ path: folder, source, owner });
  const git = process.platform === 'win32' ? windowsGitFolder() : null;
  return [
    ...(toolchain.toolBin ? [entry(toolchain.toolBin, 'glist')] : []),
    ...(cmakeBin ? [entry(cmakeBin, 'cmake')] : []),
    ...systemFolders().map((folder) => entry(folder, 'system')),
    ...(git ? [entry(git, 'git')] : []),
    ...(toolchain.pluginBins ?? []).map((folder) => entry(folder, 'plugin', path.basename(path.dirname(path.dirname(folder))))),
    ...customPath.map((folder) => entry(folder, 'custom')),
  ];
};

// Windows spells the variable Path, so it is replaced rather than joined by a second one.
// Settings > Environment: variables set for everything the studio starts, after the computer's own.
let customEnvironment: GlistVariable[] = [];

const processEnvironment = (toolchain: Toolchain): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  Object.entries(process.env).forEach(([key, value]) => { if (key.toUpperCase() !== 'PATH') env[key] = value; });
  env.PATH = pathFor(toolchain).map((entry) => entry.path).join(path.delimiter);
  customEnvironment.forEach(({ name, value }) => {
    // Windows' names are the same in any case, so one spelled otherwise gives way.
    if (process.platform === 'win32') Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase()).forEach((key) => delete env[key]);
    env[name] = value;
  });
  return env;
};

// A name is letters, digits and underscores, not starting with a digit; PATH has
// a list of its own. A later one of the same name replaces an earlier one. What
// is kept is returned, for Settings to save.
const setCustomEnvironment = (variables: unknown): GlistVariable[] => {
  const kept = new Map<string, GlistVariable>();
  (Array.isArray(variables) ? variables : []).forEach((variable: Partial<GlistVariable>) => {
    const name = typeof variable?.name === 'string' ? variable.name.trim() : '';
    const value = typeof variable?.value === 'string' ? variable.value : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toUpperCase() === 'PATH' || value.includes('\0')) return;
    kept.set(process.platform === 'win32' ? name.toUpperCase() : name, { name, value });
  });
  customEnvironment = [...kept.values()];
  return customEnvironment;
};

// Settings > Run and Debug: what the open project's program is given when Run or Debug starts it.
let runArguments: string[] = [];

const setRunArguments = (args: unknown): string[] => {
  runArguments = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string' && !arg.includes('\0')) : [];
  return runArguments;
};

// Settings > PATH: the list for the open project, or for the projects folder without one.
const pathEntries = (): GlistPathEntry[] => pathFor(resolveToolchain(activeProjectRoot ?? projectsDirectory()))
  .map((entry) => ({ ...entry, exists: existsSync(entry.path) }));

// Only whole folders: one with the separator in it would add others with it.
// What is kept is returned, for Settings to save.
const setCustomPath = (folders: unknown): string[] => {
  customPath = [...new Set((Array.isArray(folders) ? folders : [])
    .filter((folder): folder is string => typeof folder === 'string' && path.isAbsolute(folder)
      && !folder.includes(path.delimiter) && !folder.includes('\0'))
    .map((folder) => {
      // Without a trailing separator, so tools and tools/ are one folder; a root keeps its own.
      const clean = path.normalize(folder);
      return clean.length > path.parse(clean).root.length ? clean.replace(/[\\/]+$/, '') : clean;
    }))];
  return customPath;
};

// Release for Build and Run; Debug, with symbols and no optimization, for the debugger.
type BuildType = 'Release' | 'Debug';

const buildDirectoryFor = (projectRoot: string, buildType: BuildType = 'Release'): string =>
  path.join(projectRoot, '_build', buildType);

// Builds and runs get a process group of their own on POSIX, so Stop can end
// what they started too: make, the compilers, and whatever the app spawns.
const ownProcessGroup = process.platform !== 'win32';

const killTree = (child: ChildProcessWithoutNullStreams): void => {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .once('error', () => child.kill());
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
};

const runBuildCommand = (
  executable: string,
  args: string[],
  workingDirectory: string,
  toolchain: Toolchain,
): Promise<number> => new Promise((resolve, reject) => {
  sendToRenderer('build:output', `\n> ${path.basename(executable)} ${args.join(' ')}\n`);
  const child = spawn(executable, args, {
    cwd: workingDirectory,
    // Colored progress from CMake's makefiles, and colored diagnostics from the
    // compiler in build trees created from now on.
    env: { ...processEnvironment(toolchain), CLICOLOR_FORCE: '1', CMAKE_COLOR_DIAGNOSTICS: 'ON' },
    windowsHide: true,
    detached: ownProcessGroup,
  });
  buildProcess = child;
  child.stdout.on('data', (chunk: Buffer) => sendToRenderer('build:output', chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => sendToRenderer('build:output', chunk.toString()));
  // A stopped build may end after the next one started; leave that one alone.
  child.once('error', (error) => { if (buildProcess === child) buildProcess = null; reject(error); });
  child.once('close', (exitCode) => { if (buildProcess === child) buildProcess = null; resolve(exitCode ?? 1); });
});

// Stop bumps the generation, so a stopped build notices at its next step and
// leaves the build that follows it alone.
let building = false;
let buildGeneration = 0;

const sameFolder = async (left: string, right: string): Promise<boolean> => {
  const real = async (folder: string): Promise<string> => fs.realpath(folder).catch(() => path.resolve(folder));
  const [first, second] = await Promise.all([real(left), real(right)]);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
};

// A build folder remembers the source folder it was made for, and CMake will
// not use it for another, so a project moved or copied since gets a new one.
// Only the project's own build folder, and only when it really is inside it.
const replaceMovedBuildDirectory = async (projectRoot: string, buildDirectory: string): Promise<void> => {
  const cache = await fs.readFile(path.join(buildDirectory, 'CMakeCache.txt'), 'utf8').catch(() => '');
  const madeFor = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(cache)?.[1]?.trim();
  if (!madeFor || await sameFolder(madeFor, projectRoot)) return;
  const [realRoot, realBuild] = await Promise.all([fs.realpath(projectRoot), fs.realpath(buildDirectory)]);
  if (realBuild === realRoot || !isInside(realRoot, realBuild)) return;
  sendToRenderer('build:output', `\n${msg('buildFolderMoved').replace('{folder}', madeFor)}\n`);
  await fs.rm(buildDirectory, { recursive: true, force: true });
};

// Whether the compile commands clangd reads (the Release ones) changed since the studio was last told.
let compileCommandsChanged = false;

// clangd starts again on new compile commands, and indexes them, so a build tells it once make is done.
const tellClangd = (): void => {
  if (compileCommandsChanged) sendToRenderer('clangd:compile-commands', null);
  compileCommandsChanged = false;
};

// CMake's configure step, which Build, Debug and configuring on a change share.
const configure = async (projectRoot: string, buildType: BuildType, toolchain: Toolchain): Promise<number> => {
  const buildDirectory = buildDirectoryFor(projectRoot, buildType);
  const commands = path.join(buildDirectory, 'compile_commands.json');
  const before = buildType === 'Release' ? await contentHash(commands) : '';
  const code = await configureIn(projectRoot, buildDirectory, buildType, toolchain);
  if (buildType === 'Release' && await contentHash(commands) !== before) compileCommandsChanged = true;
  return code;
};

const configureIn = async (projectRoot: string, buildDirectory: string, buildType: BuildType, toolchain: Toolchain): Promise<number> => {
  await replaceMovedBuildDirectory(projectRoot, buildDirectory);
  await askForTargets(buildDirectory);
  const args = [
    '-S', projectRoot, '-B', buildDirectory,
    `-DCMAKE_BUILD_TYPE=${buildType}`, '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
  ];
  if (!existsSync(path.join(buildDirectory, 'CMakeCache.txt')) && toolchain.generator) args.push('-G', toolchain.generator);
  return runBuildCommand(toolchain.cmake, args, projectRoot, toolchain);
};

// The targets of a build, as CLion lists them: CMake describes them through its
// file API when asked before configuring, so every configure asks.
const targetReply = (buildDirectory: string): string => path.join(buildDirectory, '.cmake', 'api', 'v1', 'reply');

const askForTargets = async (buildDirectory: string): Promise<void> => {
  const query = path.join(buildDirectory, '.cmake', 'api', 'v1', 'query', 'client-gliststudio', 'codemodel-v2');
  await fs.mkdir(path.dirname(query), { recursive: true }).then(() => fs.writeFile(query, '')).catch((): undefined => undefined);
};

const targetTypes: Record<string, GlistTarget['type']> = {
  EXECUTABLE: 'executable', STATIC_LIBRARY: 'library', SHARED_LIBRARY: 'library', MODULE_LIBRARY: 'library', UTILITY: 'utility',
};

const readTargets = async (projectRoot: string, buildType: BuildType): Promise<GlistTarget[]> => {
  const reply = targetReply(buildDirectoryFor(projectRoot, buildType));
  const json = async (file: string): Promise<any> => JSON.parse(await fs.readFile(path.join(reply, file), 'utf8')); // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    const indexes = (await fs.readdir(reply)).filter((name) => /^index-.*\.json$/.test(name)).sort();
    if (indexes.length === 0) return [];
    const index = await json(indexes[indexes.length - 1]);
    const codemodel = await json(index.reply['client-gliststudio']['codemodel-v2'].jsonFile);
    const { source: sourceRoot, build: buildRoot } = codemodel.paths as { source: string; build: string };
    const workspaceRoot = findAncestorWith(projectRoot, path.join('GlistEngine', 'engine')) ?? path.resolve(projectRoot, '..', '..');
    const plugins = path.join(workspaceRoot, 'glistplugins');
    const appName = await readAppName(projectRoot);
    const targets: GlistTarget[] = [];
    for (const entry of codemodel.configurations?.[0]?.targets ?? []) {
      const target = await json(entry.jsonFile);
      const type = targetTypes[target.type as string];
      if (!type) continue;
      const source = path.resolve(sourceRoot, target.paths?.source ?? '.');
      const plugin = isInside(plugins, source) ? path.relative(plugins, source).split(path.sep)[0] : '';
      const group: GlistTarget['group'] = isInside(projectRoot, source) ? 'project'
        : isInside(path.join(workspaceRoot, 'GlistEngine'), source) ? 'engine' : plugin ? 'plugin' : 'other';
      const artifact = type === 'executable' && target.artifacts?.[0]?.path ? path.resolve(buildRoot, target.artifacts[0].path) : undefined;
      targets.push({ name: target.name, type, group, owner: group === 'plugin' ? plugin : '', app: group === 'project' && target.name === appName, ...(artifact ? { artifact } : {}) });
    }
    // The app first, then the project's other targets, the engine's, and each plugin's.
    const order: Record<GlistTarget['group'], number> = { project: 0, engine: 1, plugin: 2, other: 3 };
    return targets.sort((a, b) => Number(b.app) - Number(a.app) || order[a.group] - order[b.group]
      || a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
};

// The target Build, Run and Debug use, from the list beside Run; null for the
// app, built with everything, as without Settings > Build > Show all targets.
let chosenTarget: string | null = null;

const setTarget = (name: unknown): void => {
  chosenTarget = typeof name === 'string' && /^[\w.+][\w.+-]*$/.test(name) ? name : null;
};

// Projects configured to list their targets, once each, so a configure that
// fails is not tried again every time the list is asked for.
const configuredForTargets = new Set<string>();

const listTargets = async (): Promise<GlistTarget[]> => {
  const projectRoot = requireProjectRoot();
  const targets = await readTargets(projectRoot, 'Release');
  // A build folder configured before targets were asked for tells after one configure.
  if (targets.length > 0 || building || configuredForTargets.has(projectRoot) || !existsSync(path.join(projectRoot, 'CMakeLists.txt'))) return targets;
  configuredForTargets.add(projectRoot);
  await configureNow(projectRoot);
  return projectRoot === activeProjectRoot ? readTargets(projectRoot, 'Release') : [];
};

// The program the chosen target makes, or the app's.
const programFor = async (projectRoot: string, buildType: BuildType): Promise<ProcessResult & { program?: string }> => {
  if (!chosenTarget) {
    const program = await findRunnable(projectRoot, buildType);
    return program ? { success: true, message: '', program } : { success: false, message: msg('executableMissing') };
  }
  const target = (await readTargets(projectRoot, buildType)).find((entry) => entry.name === chosenTarget);
  if (target && target.type !== 'executable') return { success: false, message: msg('notRunnable').replace('{name}', target.name) };
  return target?.artifact && existsSync(target.artifact)
    ? { success: true, message: '', program: target.artifact } : { success: false, message: msg('executableMissing') };
};

const configureAndBuild = async (buildType: BuildType = 'Release'): Promise<ProcessResult> => {
  if (building) return { success: false, message: msg('buildRunning') };
  building = true;
  buildGeneration += 1;
  const generation = buildGeneration;
  const stopped = (): boolean => generation !== buildGeneration;
  const projectRoot = requireProjectRoot();
  const toolchain = resolveToolchain(projectRoot);
  const buildDirectory = buildDirectoryFor(projectRoot, buildType);

  sendToRenderer('build:status', { running: true, label: msg('configuring') });
  try {
    const configureCode = await configure(projectRoot, buildType, toolchain);
    if (buildType === 'Release') await rememberConfiguration(projectRoot);
    if (stopped()) return { success: false, message: msg('stopped') };
    if (configureCode !== 0) {
      return { success: false, message: `${msg('configureFailed')}: ${configureCode}.` };
    }
    sendToRenderer('build:status', { running: true, label: msg('building') });
    const buildCode = await runBuildCommand(
      // A bare --parallel lets make start every job at once.
      toolchain.cmake, ['--build', buildDirectory, ...(chosenTarget ? ['--target', chosenTarget] : []), '--parallel', String(availableParallelism())],
      projectRoot, toolchain,
    );
    return buildCode === 0
      ? { success: true, message: msg('buildSucceeded') }
      : { success: false, message: `${msg('buildFailed')}: ${buildCode}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `${msg('buildStartFailed')}: ${message}` };
  } finally {
    tellClangd();
    if (!stopped()) {
      building = false;
      sendToRenderer('build:status', { running: false, label: msg('ready') });
    }
  }
};

// Configuring again when CMake's files change, as CLion reloads a CMake project,
// so clangd follows new files and settings without a build. The files are the
// ones CMake read last time (the project's, the engine's, its plugins'); what
// they held then is kept, so a save that changes nothing, or a file CMake
// writes itself, does not configure again.
let autoConfigure = true;
let configurationWatchers: FSWatcher[] = [];
let configureTimer: NodeJS.Timeout | null = null;
let configuredContents = new Map<string, string>();

const contentHash = async (file: string): Promise<string> =>
  fs.readFile(file).then((data) => createHash('sha1').update(data).digest('hex'), () => '');

const configurationFiles = async (projectRoot: string): Promise<string[]> => {
  const buildDirectory = buildDirectoryFor(projectRoot);
  const makefile = await fs.readFile(path.join(buildDirectory, 'CMakeFiles', 'Makefile.cmake'), 'utf8').catch(() => '');
  const workspace = findAncestorWith(projectRoot, path.join('GlistEngine', 'engine')) ?? path.resolve(projectRoot, '..', '..');
  const builds = path.join(projectRoot, '_build');
  const read = cmakeInputs(makefile).map((file) => path.resolve(buildDirectory, file))
    .filter((file) => !isInside(builds, file) && (isInside(projectRoot, file) || isInside(workspace, file)));
  if (read.length > 0) return [...new Set(read)];
  // Before the first configure, or in a build folder made elsewhere: the project's, the engine's and its plugins'.
  const dependencies = await listDependencies().catch((): GlistDependency[] => []);
  return [path.join(projectRoot, 'CMakeLists.txt'), ...dependencies.map((dependency) => (dependency.kind === 'engine'
    ? path.join(dependency.path, 'engine', 'CMakeLists.txt') : path.join(dependency.path, 'CMakeLists.txt')))];
};

export const stopWatchingConfiguration = (): void => {
  configurationWatchers.forEach((watcher) => watcher.close());
  configurationWatchers = [];
  if (configureTimer) clearTimeout(configureTimer);
  configureTimer = null;
};

// Takes what the files hold now as configured, and watches them for the next change.
const rememberConfiguration = async (projectRoot: string): Promise<void> => {
  const files = await configurationFiles(projectRoot);
  const contents = new Map(await Promise.all(files.map(async (file): Promise<[string, string]> => [file, await contentHash(file)])));
  if (projectRoot !== activeProjectRoot) return;
  configuredContents = contents;
  stopWatchingConfiguration();
  if (!autoConfigure) return;
  const byFolder = new Map<string, Set<string>>();
  files.forEach((file) => {
    const names = byFolder.get(path.dirname(file)) ?? new Set<string>();
    names.add(path.basename(file));
    byFolder.set(path.dirname(file), names);
  });
  byFolder.forEach((names, folder) => {
    try {
      const watcher = watch(folder, { persistent: false }, (_event, name) => { if (name && names.has(name.toString())) scheduleConfigure(); });
      watcher.on('error', () => undefined);
      configurationWatchers.push(watcher);
    } catch { /* A folder that is gone is not watched. */ }
  });
};

const configurationChanged = async (): Promise<boolean> => {
  for (const [file, hash] of configuredContents) if (await contentHash(file) !== hash) return true;
  return false;
};

const scheduleConfigure = (): void => {
  if (configureTimer) clearTimeout(configureTimer);
  configureTimer = setTimeout(() => { configureTimer = null; void configureOnChange(); }, 1500);
};

const configureOnChange = async (): Promise<void> => {
  const projectRoot = activeProjectRoot;
  if (!autoConfigure || !projectRoot || !existsSync(path.join(projectRoot, 'CMakeLists.txt')) || !(await configurationChanged())) return;
  // A build configures on its own first; after it, this looks again.
  if (building) { scheduleConfigure(); return; }
  await configureNow(projectRoot);
};

// Configures outside a build, showing it as a build does, and says how it went.
const configureNow = async (projectRoot: string): Promise<void> => {
  building = true;
  buildGeneration += 1;
  const generation = buildGeneration;
  sendToRenderer('build:status', { running: true, label: msg('configuring') });
  sendToRenderer('build:output', '\n── CONFIGURE ────────────────────────────────────\n');
  let code = 1;
  try {
    code = await configure(projectRoot, 'Release', resolveToolchain(projectRoot));
    tellClangd();
  } catch (error) {
    sendToRenderer('build:output', `${msg('buildStartFailed')}: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    if (generation === buildGeneration) {
      building = false;
      sendToRenderer('build:status', { running: false, label: msg('ready') });
    }
  }
  if (generation !== buildGeneration || projectRoot !== activeProjectRoot) return;
  await rememberConfiguration(projectRoot);
  sendToRenderer('build:configured', { success: code === 0, message: code === 0 ? msg('configured') : `${msg('configureFailed')}: ${code}.` });
};

const setAutoConfigure = (on: unknown): void => {
  autoConfigure = on !== false;
  if (activeProjectRoot) void rememberConfiguration(activeProjectRoot);
  else stopWatchingConfiguration();
};

const readAppName = async (projectRoot: string): Promise<string> => {
  try {
    const cmake = await fs.readFile(path.join(projectRoot, 'CMakeLists.txt'), 'utf8');
    const appName = cmake.match(/set\s*\(\s*APP_NAME\s+["']?([^\s"')]+)/i);
    if (appName) return appName[1];
    return cmake.match(/project\s*\(\s*["']?([^\s"')]+)/i)?.[1] ?? path.basename(projectRoot);
  } catch {
    return path.basename(projectRoot);
  }
};

const findRunnable = async (projectRoot: string, buildType: BuildType = 'Release'): Promise<string | null> => {
  const buildDirectory = buildDirectoryFor(projectRoot, buildType);
  const appName = await readAppName(projectRoot);
  const expected = path.join(buildDirectory, process.platform === 'win32' ? `${appName}.exe` : appName);
  if (existsSync(expected)) return expected;
  try {
    const files = await fs.readdir(buildDirectory, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || file.name.toLowerCase().includes('shadertoheader')) continue;
      const candidate = path.join(buildDirectory, file.name);
      if (process.platform === 'win32' ? file.name.endsWith('.exe') : ((await fs.stat(candidate)).mode & 0o111) !== 0) {
        return candidate;
      }
    }
    return null;
  } catch {
    return null;
  }
};

const runProject = async (): Promise<ProcessResult> => {
  if (runProcess) return { success: false, message: msg('appRunning') };
  const projectRoot = requireProjectRoot();
  sendToRenderer('run:output', '\n── BUILD & RUN ──────────────────────────────────\n');
  const buildResult = await configureAndBuild();
  if (!buildResult.success) {
    return { success: false, message: `${msg('runCancelled')}: ${buildResult.message}` };
  }
  const found = await programFor(projectRoot, 'Release');
  if (!found.program) return found;
  const executable = found.program;
  const toolchain = resolveToolchain(projectRoot);
  sendToRenderer('run:output', `\n> ${executable}\n`);
  try {
    const child = spawn(executable, runArguments, {
      // Glist resolves asset paths relative to the project directory. The
      // executable lives in _build/Release, but it must run from projectRoot.
      cwd: projectRoot,
      env: processEnvironment(toolchain),
      windowsHide: false,
      detached: ownProcessGroup,
    });
    runProcess = child;
    sendToRenderer('run:status', { running: true });
    child.stdout.on('data', (chunk: Buffer) => sendToRenderer('run:output', chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => sendToRenderer('run:output', chunk.toString()));
    child.once('error', (error) => sendToRenderer('run:output', `${msg('launchFailed')}: ${error.message}\n`));
    child.once('close', (exitCode) => {
      if (runProcess !== child) return;
      runProcess = null;
      // A stopped app has no exit code, only the signal that ended it.
      sendToRenderer('run:status', { running: false, exitCode: exitCode ?? undefined });
    });
    return { success: true, message: `${path.basename(executable)} ${msg('launched')}.` };
  } catch (error) {
    runProcess = null;
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `${msg('launchFailed')}: ${message}` };
  }
};

export const stopProcesses = (): ProcessResult => {
  let stopped = false;
  if (building) {
    buildGeneration += 1;
    building = false;
    if (buildProcess) killTree(buildProcess);
    buildProcess = null;
    stopped = true;
  }
  if (runProcess) { killTree(runProcess); runProcess = null; stopped = true; }
  sendToRenderer('build:status', { running: false, label: msg('ready') });
  sendToRenderer('run:status', { running: false });
  return { success: stopped, message: msg(stopped ? 'stopped' : 'nothingToStop') };
};

// Projects opened before, newest first, kept in Glist Studio's folder so both
// the app and the browser build share them.
interface RecentProject { root: string; openedAt: number }
const recentProjectsFile = (): string => path.join(studioHome(), 'recent-projects.json');

const readRecentProjects = async (): Promise<RecentProject[]> => {
  try {
    const saved = JSON.parse(await fs.readFile(recentProjectsFile(), 'utf8')) as unknown;
    return Array.isArray(saved)
      ? saved.filter((entry): entry is RecentProject => typeof entry?.root === 'string' && Number.isFinite(entry?.openedAt))
      : [];
  } catch {
    return [];
  }
};

const rememberProject = async (root: string): Promise<void> => {
  const recent = [{ root, openedAt: Date.now() }, ...(await readRecentProjects()).filter((entry) => entry.root !== root)];
  await fs.mkdir(studioHome(), { recursive: true });
  await fs.writeFile(recentProjectsFile(), JSON.stringify(recent.slice(0, 50), null, 2), 'utf8');
};

// A path as people write it, with the home folder as ~ outside Windows.
const shortPath = (target: string): string => (process.platform !== 'win32' && isInside(homedir(), target)
  ? `~${target.slice(homedir().length)}` : target);

// What Open Project offers: the projects in the workspace's myglistapps folder
// and the ones opened before that still exist, most recently opened first,
// then the rest by name.
const listProjects = async (): Promise<GlistProjectSummary[]> => {
  const recent = await readRecentProjects();
  const openedAt = new Map(recent.map((entry) => [entry.root, entry.openedAt]));
  const roots = new Set<string>();
  const directory = projectsDirectory();
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((): Dirent[] => []);
  entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(path.join(directory, entry.name, 'CMakeLists.txt')))
    .forEach((entry) => roots.add(path.join(directory, entry.name)));
  recent.filter((entry) => existsSync(entry.root)).forEach((entry) => roots.add(entry.root));
  return [...roots]
    .map((root) => ({ root, name: path.basename(root), location: shortPath(root), lastOpened: openedAt.get(root) }))
    .sort((left, right) => (right.lastOpened ?? 0) - (left.lastOpened ?? 0)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true }));
};

export const openProjectAt = async (projectRoot: string): Promise<GlistProjectInfo> => {
  const root = path.resolve(projectRoot);
  if (!(await fs.stat(root)).isDirectory()) throw new Error(msg('folderRequired'));
  activeProjectRoot = root;
  chosenTarget = null;
  runArguments = [];
  await rememberProject(root).catch((): undefined => undefined);
  void git.projectChanged();
  void rememberConfiguration(root);
  return {
    root,
    name: path.basename(root),
    hasCMakeProject: existsSync(path.join(root, 'CMakeLists.txt')),
  };
};

const readTextFile = async (filePath: string): Promise<string> => {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error(msg('fileRequired'));
  if (stats.size > 5 * 1024 * 1024) throw new Error(msg('fileTooLarge'));
  return fs.readFile(filePath, 'utf8');
};

const readProjectFile = async (filePath: string): Promise<string> =>
  readTextFile(await assertExistingPathInProject(filePath));

// Go to definition lands in engine and plugin headers, so files anywhere in
// the Glist workspace (the folder holding GlistEngine) may be read, never written.
const readWorkspaceFile = async (filePath: string): Promise<string> => {
  const workspaceRoot = findAncestorWith(requireProjectRoot(), path.join('GlistEngine', 'engine'));
  const realFile = await fs.realpath(path.resolve(filePath));
  if (!workspaceRoot || !isInside(await fs.realpath(workspaceRoot), realFile)) throw new Error(msg('outsideProject'));
  return readTextFile(realFile);
};

// What an app is built with, for the explorer: the engine, and the plugins its
// CMakeLists.txt names, from the Glist workspace it reaches as ../..
const listDependencies = async (): Promise<GlistDependency[]> => {
  const projectRoot = requireProjectRoot();
  const workspaceRoot = findAncestorWith(projectRoot, path.join('GlistEngine', 'engine')) ?? path.resolve(projectRoot, '..', '..');
  const cmake = await fs.readFile(path.join(projectRoot, 'CMakeLists.txt'), 'utf8').catch(() => '');
  const engine = path.join(workspaceRoot, 'GlistEngine');
  return [
    { name: 'GlistEngine', kind: 'engine' as const, path: engine, exists: existsSync(engine) },
    ...pluginsInCmake(cmake).map((name) => {
      const plugin = path.join(workspaceRoot, 'glistplugins', name);
      return { name, kind: 'plugin' as const, path: plugin, exists: existsSync(plugin) };
    }),
  ];
};

// Where Find in Files and Search Everywhere look: the project, and with
// dependencies, the engine and the plugins it names.
const searchFoldersFor = async (dependencies: boolean): Promise<SearchFolder[]> => {
  const projectRoot = requireProjectRoot();
  const folders: SearchFolder[] = [{ path: projectRoot, name: path.basename(projectRoot), kind: 'project' }];
  if (!dependencies) return folders;
  for (const dependency of await listDependencies()) {
    if (dependency.exists) folders.push({ path: dependency.path, name: dependency.name, kind: dependency.kind });
  }
  return folders;
};

// Typing starts a new search before the last one ends; the last one stops.
let searchTicket = 0;
const searchText = async (query: unknown): Promise<GlistSearchResult> => {
  searchTicket += 1;
  const ticket = searchTicket;
  const asked = (query ?? {}) as GlistSearchQuery;
  const text = typeof asked.text === 'string' ? asked.text : '';
  const options = { text, matchCase: asked.matchCase === true, wholeWords: asked.wholeWords === true, regex: asked.regex === true };
  try { queryPattern(options); } catch { throw new Error(msg('invalidRegex')); }
  const folders = await searchFoldersFor(asked.scope === 'all');
  const outcome = await searchFolders(folders, options, 2000, () => ticket !== searchTicket);
  return { ...outcome, folders: folders.map(({ path: folder, name, kind }) => ({ path: folder, name, kind })) };
};

const listFiles = async (dependencies: unknown): Promise<GlistFoundFile[]> =>
  filesIn(await searchFoldersFor(dependencies === true), 20000);

// Folders of the engine and plugins, to browse; like their files, never written.
const listWorkspaceDirectory = async (directoryPath: string): Promise<FileEntry[]> => {
  const workspaceRoot = findAncestorWith(requireProjectRoot(), path.join('GlistEngine', 'engine'));
  const realDirectory = await fs.realpath(path.resolve(directoryPath));
  if (!workspaceRoot || !isInside(await fs.realpath(workspaceRoot), realDirectory)) throw new Error(msg('outsideProject'));
  return listEntries(realDirectory, directoryPath);
};

// A file in the engine or a plugin the open project names. Neither builds on its
// own, so their work happens from an app; other workspace files stay read-only.
const dependencyFile = async (filePath: string): Promise<string> => {
  const target = path.resolve(filePath);
  const directory = path.dirname(target);
  if (existsSync(directory)) {
    const real = existsSync(target) ? await fs.realpath(target) : path.join(await fs.realpath(directory), path.basename(target));
    for (const dependency of await listDependencies()) {
      if (!dependency.exists) continue;
      const folder = await fs.realpath(dependency.path);
      if (real !== folder && isInside(folder, real)) return real;
    }
  }
  throw new Error(msg('outsideProject'));
};

const writeProjectFile = async (filePath: string, contents: string): Promise<boolean> => {
  if (!isInside(path.resolve(requireProjectRoot()), path.resolve(filePath))) {
    await fs.writeFile(await dependencyFile(filePath), contents, 'utf8');
    return true;
  }
  // A file deleted behind the editor's back is written again, into a folder that still exists.
  const target = existsSync(filePath)
    ? await assertExistingPathInProject(filePath)
    : path.join(await assertExistingPathInProject(path.dirname(assertPathInProject(filePath))), path.basename(filePath));
  await fs.writeFile(target, contents, 'utf8');
  return true;
};

const clangd = new MessageProcess(
  (message) => sendToRenderer('clangd:message', message),
  (status) => sendToRenderer('clangd:status', status),
);

const startClangd = async (): Promise<GlistClangdStatus> => {
  const projectRoot = requireProjectRoot();
  const toolchain = resolveToolchain(projectRoot);
  // A project may so far only have been built for debugging.
  const database = (['Release', 'Debug'] as const).map((type) => buildDirectoryFor(projectRoot, type))
    .find((directory) => existsSync(path.join(directory, 'compile_commands.json')));
  const buildDirectory = database ?? buildDirectoryFor(projectRoot);
  const compileCommands = Boolean(database);
  const args = [`--compile-commands-dir=${buildDirectory}`, '--background-index', '--log=error'];
  // Lets clangd ask the Glist clang for its system headers and target.
  if (toolchain.toolBin) args.push(`--query-driver=${path.join(toolchain.toolBin, '*').replace(/\\/g, '/')}`);
  const status = await clangd.start({ command: 'clangd', args, cwd: projectRoot, env: processEnvironment(toolchain) });
  if (!status.running) return { running: false, message: `${msg('clangdMissing')}: ${status.message}` };
  // Without them, the renderer says to build once (clangd.ts, buildNeeded).
  return { running: true, message: '', compileCommands };
};

export const stopClangd = (): void => clangd.stop();

const debugAdapter = new MessageProcess(
  (message) => sendToRenderer('debug:message', message),
  (status) => sendToRenderer('debug:status', status),
);

// Builds the Debug configuration and starts a debug adapter for it. The
// renderer then launches the program through the adapter.
const startDebugging = async (): Promise<GlistDebugStart> => {
  const projectRoot = requireProjectRoot();
  const build = await configureAndBuild('Debug');
  if (!build.success) return { success: false, message: `${msg('debugCancelled')}: ${build.message}` };
  const found = await programFor(projectRoot, 'Debug');
  if (!found.program) return { success: false, message: found.message };
  const { program } = found;
  const env = processEnvironment(resolveToolchain(projectRoot));
  const installedGdb = installedDebugger(studioHome());
  const adapter = await findDebugAdapter(env, installedGdb);
  if (!adapter) {
    return process.platform === 'win32'
      ? { success: false, message: msg('debuggerMissingWindows'), missingDebugger: true }
      : { success: false, message: msg('debuggerMissing') };
  }
  // The GDB Settings installed can be installed again when it fails.
  const ours = adapter.command === installedGdb;
  const status = await debugAdapter.start({ command: adapter.command, args: adapter.args, cwd: projectRoot, env });
  if (!status.running) return { success: false, message: `${msg('debuggerFailed')}: ${status.message}`, installedDebugger: ours };
  return { success: true, message: '', program, cwd: projectRoot, args: runArguments, flavor: adapter.flavor, installedDebugger: ours };
};

export const stopDebugging = (): void => debugAdapter.stop();

// Terminals: a shell in the project folder, and the Agent tab's agent, both
// with the environment builds use. node-pty is loaded on first use, so a
// platform without it only loses these.
type TerminalSession = 'shell' | 'agent' | 'install';
// What a session needs of its program: a pseudo-terminal, or for the installer
// usually a plain child process (see installerProgram).
type TerminalProcess = Pick<IPty, 'write' | 'resize' | 'kill'>;
const terminalSessions = new Map<TerminalSession, TerminalProcess>();
const sessionName = (value: unknown): TerminalSession | null =>
  (value === 'shell' || value === 'agent' || value === 'install' ? value : null);

const terminalShell = (): { file: string; args: string[] } => {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] };
  return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: [] };
};

const terminalSize = (value: unknown, fallback: number): number => {
  const size = Math.floor(Number(value));
  return Number.isFinite(size) ? Math.min(1000, Math.max(2, size)) : fallback;
};

// Ends one session, or all of them.
export const stopTerminal = (session?: unknown): void => {
  const names = session === undefined ? [...terminalSessions.keys()] : [sessionName(session)];
  names.forEach((name) => {
    const running = name && terminalSessions.get(name);
    if (!name || !running) return;
    terminalSessions.delete(name);
    try { running.kill(); } catch { /* It has already exited. */ }
  });
};

const terminalDirectory = (): string => activeProjectRoot
  ?? [projectsDirectory(), homedir()].find((candidate) => existsSync(candidate))
  ?? process.cwd();

// Agents are looked for on the computer's own PATH too, wherever they were
// installed; each then runs with the studio's PATH and its own folder.
const agentPlaces = (env: NodeJS.ProcessEnv): AgentPlaces => ({
  home: studioHome(), glist: glistRoot(), searchPath: [env.PATH ?? '', osPath()].filter(Boolean).join(path.delimiter),
});

// Whether Glist is set up where the install scripts put it, or where the
// projects folder this studio was given points.
// A password the installer needs for sudo is asked for by the system, never
// typed into the studio: sudo, run without a terminal and with DISPLAY set,
// hands the question to the program in SUDO_ASKPASS. macOS shows its own dialog; Linux uses the
// desktop's password dialog, and only without one falls back to the terminal.
const linuxAskpassPrograms = [
  'zenity', 'kdialog', 'ssh-askpass', '/usr/lib/ssh/ssh-askpass', '/usr/libexec/openssh/ssh-askpass',
  '/usr/lib/openssh/gnome-ssh-askpass', '/usr/libexec/openssh/gnome-ssh-askpass',
];

const passwordPrompt = (): GlistInstallStatus['passwordPrompt'] => {
  if (process.platform === 'win32') return 'none';
  if (process.platform === 'darwin') return 'system';
  const searchPath = (process.env.PATH ?? '').split(path.delimiter);
  const found = linuxAskpassPrograms.some((program) => (path.isAbsolute(program)
    ? existsSync(program) : searchPath.some((directory) => existsSync(path.join(directory, program)))));
  return found ? 'system' : 'terminal';
};

// The prompt goes into an AppleScript string inside a single-quoted shell word,
// or into a double-quoted shell word.
const appleScriptInShell = (text: string): string => text.replace(/[\\"]/g, '\\$&').replace(/'/g, "'\\''");
const inDoubleQuotes = (text: string): string => text.replace(/[\\"$`]/g, '\\$&');

const askpassScript = (): string => (process.platform === 'darwin'
  ? `#!/bin/sh
# SUDO_ASKPASS for Glist Engine's installer: a macOS dialog asks for the
# password and hands it to sudo, without it passing through Glist Studio.
exec /usr/bin/osascript -e 'text returned of (display dialog "${appleScriptInShell(msg('askpassPrompt'))}" default answer "" with hidden answer with title "Glist Engine" with icon caution)'
`
  : `#!/bin/sh
# SUDO_ASKPASS for Glist Engine's installer: the desktop's password dialog
# asks for it and hands it to sudo, without it passing through Glist Studio.
prompt="${inDoubleQuotes(msg('askpassPrompt'))}"
command -v zenity >/dev/null 2>&1 && exec zenity --password --title="Glist Engine"
command -v kdialog >/dev/null 2>&1 && exec kdialog --title "Glist Engine" --password "$prompt"
for helper in ${linuxAskpassPrograms.slice(2).join(' ')}; do
  command -v "$helper" >/dev/null 2>&1 && exec "$helper" "$prompt"
done
exit 1
`);

const glistStatus = (): GlistInstallStatus => ({
  installed: existsSync(path.join(glistRoot(), 'GlistEngine', 'engine'))
    || Boolean(findAncestorWith(host.projectsDirectory, path.join('GlistEngine', 'engine'))),
  root: glistRoot(),
  location: shortPath(glistRoot()),
  passwordPrompt: passwordPrompt(),
});

// Settings > About: this Glist Studio, the engine and the open project's plugins
// with their branch and commit, and what runs it all.
const aboutInfo = async (): Promise<GlistAbout> => {
  const folders = activeProjectRoot ? await listDependencies()
    : [{ name: 'GlistEngine', kind: 'engine' as const, path: path.join(path.dirname(projectsDirectory()), 'GlistEngine') }]
      .map((entry) => ({ ...entry, exists: existsSync(entry.path) }));
  const repositories = await Promise.all(folders.map(async (entry): Promise<GlistAboutRepository> => {
    const head = entry.exists ? await readRepositoryHead(entry.path) : null;
    return { name: entry.name, kind: entry.kind, location: shortPath(entry.path), found: entry.exists, ...(head ? { head } : {}) };
  }));
  // Electron gives the system's own version, such as macOS 26.0; Node only the kernel's, such as Darwin 25.0.0.
  const systemVersion = (process as { getSystemVersion?: () => string }).getSystemVersion?.();
  const system = systemVersion
    ? ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[process.platform] ?? process.platform : type();
  return {
    version: host.version,
    head: await host.studioHead().catch((): null => null),
    repositories,
    runtime: [
      ...(process.versions.electron ? [{ name: 'Electron', version: process.versions.electron }, { name: 'Chromium', version: process.versions.chrome }] : []),
      { name: 'Node.js', version: process.versions.node },
      { name: system, version: `${systemVersion ?? release()} (${process.arch})` },
    ],
  };
};

// Glist Engine's own installer: the current script from GlistEngine/InstallScripts,
// saved in Glist Studio's folder and run in a terminal, so that a password it
// asks for can be typed. GLIST_STUDIO_INSTALLER runs a local script instead, for tests.
const installerProgram = async (): Promise<{ file: string; args: string[] }> => {
  const windows = process.platform === 'win32';
  let script = process.env.GLIST_STUDIO_INSTALLER ? path.resolve(process.env.GLIST_STUDIO_INSTALLER) : '';
  if (!script) {
    const system = windows ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
    const file = windows ? 'install-glist.ps1' : 'install-glist.sh';
    const response = await fetch(`https://raw.githubusercontent.com/GlistEngine/InstallScripts/main/scripts/${system}/${file}`);
    if (!response.ok) throw new Error(`raw.githubusercontent.com: ${response.status}`);
    script = path.join(studioHome(), 'installer', file);
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, await response.text(), 'utf8');
  }
  return windows
    ? { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] }
    : { file: '/bin/bash', args: [script] };
};

const startTerminal = async (session: unknown, columns: number, rows: number, agent?: unknown): Promise<ProcessResult> => {
  const name = sessionName(session);
  if (!name) return { success: false, message: msg('terminalFailed') };
  stopTerminal(name);
  let directory = terminalDirectory();
  const env: NodeJS.ProcessEnv = {
    ...processEnvironment(resolveToolchain(directory)), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'GlistStudio',
  };
  let program = terminalShell();
  if (name === 'agent') {
    const launch = isAgentId(agent) ? await agentLaunch(agent, agentPlaces(env)) : null;
    if (!launch) return { success: false, message: msg('agentMissing') };
    program = { file: launch.file, args: launch.args };
    Object.assign(env, launch.env);
    env.PATH = [...launch.pathPrefix, env.PATH ?? ''].join(path.delimiter);
  }
  if (name === 'install') {
    try { program = await installerProgram(); } catch (error) {
      return { success: false, message: `${msg('installerMissing')}: ${error instanceof Error ? error.message : String(error)}` };
    }
    // From GlistEngine's own repositories, asking nothing but a password, and
    // without the Eclipse setup the studio does not need. It installs what the
    // computer lacks, so it gets the computer's own PATH.
    Object.assign(env, { GLIST_UNATTENDED: '1', GLIST_NO_ECLIPSE: '1', GLIST_GITHUB_USERNAME: 'GlistEngine', PATH: osPath() });
    directory = homedir();
    if (passwordPrompt() === 'system') {
      const askpass = path.join(studioHome(), 'installer', 'askpass.sh');
      await fs.mkdir(path.dirname(askpass), { recursive: true });
      await fs.writeFile(askpass, askpassScript(), { encoding: 'utf8', mode: 0o700 });
      await fs.chmod(askpass, 0o700);
      env.SUDO_ASKPASS = askpass;
      // Without a terminal, sudo turns to SUDO_ASKPASS only when DISPLAY is set,
      // which macOS never sets and a Wayland desktop may not.
      env.DISPLAY = env.DISPLAY || ':0';
      return startWithoutTerminal(name, program, directory, env);
    }
  }
  try {
    const { spawn: spawnTerminal } = await import('node-pty');
    const child = spawnTerminal(program.file, program.args, {
      name: 'xterm-256color', cols: terminalSize(columns, 80), rows: terminalSize(rows, 24), cwd: directory, env,
    });
    terminalSessions.set(name, child);
    // A restarted session's old process may still be finishing; only the current one reports.
    child.onData((data) => { if (terminalSessions.get(name) === child) sendToRenderer('terminal:data', { session: name, data }); });
    child.onExit(({ exitCode }) => {
      if (terminalSessions.get(name) !== child) return;
      terminalSessions.delete(name);
      sendToRenderer('terminal:exit', { session: name, exitCode });
    });
    return { success: true, message: `${path.basename(program.file)} - ${directory}` };
  } catch (error) {
    return { success: false, message: `${msg('terminalFailed')}: ${error instanceof Error ? error.message : String(error)}` };
  }
};

// The installer when sudo asks through SUDO_ASKPASS: a plain child process, in a
// process group of its own so Stop ends everything it started. xterm.js needs
// carriage returns that a program without a terminal does not print.
const startWithoutTerminal = (
  name: TerminalSession, program: { file: string; args: string[] }, directory: string, env: NodeJS.ProcessEnv,
): ProcessResult => {
  const child = spawn(program.file, program.args, { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const running: TerminalProcess = {
    write: () => undefined,
    resize: () => undefined,
    kill: () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    },
  };
  terminalSessions.set(name, running);
  const forward = (chunk: Buffer): void => {
    if (terminalSessions.get(name) === running) sendToRenderer('terminal:data', { session: name, data: chunk.toString().replace(/\r?\n/g, '\r\n') });
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  const finish = (exitCode: number): void => {
    if (terminalSessions.get(name) !== running) return;
    terminalSessions.delete(name);
    sendToRenderer('terminal:exit', { session: name, exitCode });
  };
  child.once('error', () => finish(127));
  child.once('close', (code) => finish(code ?? 1));
  return { success: true, message: `${path.basename(program.file)} - ${directory}` };
};

const writeTerminal = (session: unknown, data: unknown): void => {
  const name = sessionName(session);
  if (name && typeof data === 'string') terminalSessions.get(name)?.write(data);
};

const resizeTerminal = (session: unknown, columns: unknown, rows: unknown): void => {
  const name = sessionName(session);
  try { if (name) terminalSessions.get(name)?.resize(terminalSize(columns, 80), terminalSize(rows, 24)); } catch { /* It has just exited. */ }
};

// Agents for the Agent tab, and installing them from Settings.
const listAgents = (): Promise<AgentStatus[]> =>
  findAgents(agentPlaces(processEnvironment(resolveToolchain(terminalDirectory()))));

// Settings > Debugger: on Windows, GDB from MSYS2, pinned (debugger-download.ts).
const debuggerStatus = (): GlistDebuggerStatus => ({
  offered: process.platform === 'win32',
  installed: Boolean(installedDebugger(studioHome())),
  name: debuggerRelease.name,
  version: debuggerRelease.version,
  size: debuggerRelease.packages.reduce((total, entry) => total + entry.size, 0),
});

let installingDebugger = false;

// Again: the installed one is removed first, for one that does not start.
const installDebuggerFromSettings = async (again?: unknown): Promise<ProcessResult> => {
  if (installingDebugger) return { success: false, message: msg('debuggerInstallRunning') };
  installingDebugger = true;
  try {
    if (again === true) await removeDebugger(studioHome());
    await installDebugger(studioHome(), (text) => sendToRenderer('debugger:install-output', text));
    return { success: true, message: msg('debuggerInstalled') };
  } catch (error) {
    return { success: false, message: `${msg('debuggerInstallFailed')}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    installingDebugger = false;
  }
};

let installingAgent = false;

const installAgentFromSettings = async (agent: unknown): Promise<ProcessResult> => {
  if (!isAgentId(agent)) return { success: false, message: msg('agentMissing') };
  if (installingAgent) return { success: false, message: msg('agentInstallRunning') };
  installingAgent = true;
  const report = (text: string): void => sendToRenderer('agent:install', text);
  try {
    await installAgent(agent, agentPlaces(processEnvironment(resolveToolchain(terminalDirectory()))), report);
    return { success: true, message: msg('agentInstalled') };
  } catch (error) {
    return { success: false, message: `${msg('agentInstallFailed')}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    installingAgent = false;
  }
};

// GlistPlugins' plugins, installed beside the engine (see plugins.ts).
const plugins = createPluginService({
  workspace: () => (activeProjectRoot ? findAncestorWith(activeProjectRoot, path.join('GlistEngine', 'engine')) : null)
    ?? path.dirname(projectsDirectory()),
  projectCmake: () => (activeProjectRoot ? path.join(activeProjectRoot, 'CMakeLists.txt') : null),
  environment: () => processEnvironment(resolveToolchain(activeProjectRoot ?? projectsDirectory())),
  report: (entry) => sendToRenderer('git:console', entry),
  language: () => language,
  isProtected: (folder, remote, branch) => git.protects(folder, remote, branch),
});

// Git, for the Commit view and the Git panel (see git-service.ts).
const git = createGitService({
  projectRoot: () => activeProjectRoot,
  dependencies: () => listDependencies(),
  environment: (directory) => processEnvironment(resolveToolchain(directory)),
  send: (channel, payload) => sendToRenderer(channel, payload),
  trash: (entryPath) => host.trashItem(entryPath),
  home: studioHome,
  projectsDirectory,
  language: () => language,
});

export const stopGit = (): void => git.stop();

// The engine, updated from GlistEngine the way plugins are from GlistPlugins:
// the open project's, or the one where Glist is installed.
const engineSource = 'GlistEngine/GlistEngine';
const engineFolder = (): string => path.join(activeProjectRoot
  ? findAncestorWith(activeProjectRoot, path.join('GlistEngine', 'engine')) ?? path.resolve(activeProjectRoot, '..', '..')
  : path.dirname(projectsDirectory()), 'GlistEngine');
const engineCheckouts = createCheckouts({
  git: gitRunner(() => processEnvironment(resolveToolchain(activeProjectRoot ?? projectsDirectory())), (entry) => sendToRenderer('git:console', entry)),
  site: 'https://github.com',
  isProtected: (folder, remote, branch) => git.protects(folder, remote, branch),
  language: () => language,
});
const engineCheckout = async (refresh?: unknown): Promise<GlistEngineCheckout> => {
  const folder = engineFolder();
  const found = existsSync(path.join(folder, 'engine'));
  const state = found ? await engineCheckouts.inspect(folder, engineSource, { fetch: refresh === true }) : { repository: false };
  return { ...state, folder, location: shortPath(folder), found };
};
const updateEngine = (choice?: unknown, resolve?: unknown): Promise<GlistCheckoutResult> => engineCheckouts.update(
  engineFolder(), 'GlistEngine', engineSource, choice === 'keep' || choice === 'replace' ? choice : undefined, { resolve: resolve === true },
);

const setLanguage = (nextLanguage: Language): Language => {
  language = isLanguage(nextLanguage) ? nextLanguage : 'en';
  return language;
};

// Calls that behave the same under every host.
export const studio: Handlers = {
  createProject: createProjectFromTemplate,
  listDirectory,
  createFile: createProjectFile,
  createDirectory: createProjectDirectory,
  deleteEntry: deleteProjectEntry,
  renameEntry: renameProjectEntry,
  createCppClass,
  copyEntry: copyProjectEntry,
  importPaths,
  importFiles,
  showInExplorer: showInSystemExplorer,
  openCommandPrompt,
  readFile: readProjectFile,
  readWorkspaceFile,
  // Only style files are read, wherever the file is: clang-format looks as far up.
  codeStyle: (filePath: unknown) => (typeof filePath === 'string' ? codeStyleFor(filePath) : null),
  listDependencies,
  listWorkspaceDirectory,
  searchText,
  listFiles,
  getProjectsDirectory: projectsDirectory,
  listProjects,
  openProjectPath: (root: unknown) => {
    if (typeof root !== 'string') throw new Error(msg('folderRequired'));
    return openProjectAt(root);
  },
  getPlatform: () => process.platform,
  writeFile: writeProjectFile,
  buildProject: () => configureAndBuild('Release'),
  runProject,
  listTargets,
  setTarget,
  stopProject: stopProcesses,
  setLanguage,
  pathEntries,
  setCustomPath,
  setCustomEnvironment,
  setRunArguments,
  setAutoConfigure,
  startClangd,
  sendClangd: (message: unknown) => clangd.send(message),
  startDebugging,
  sendDebug: (message: unknown) => debugAdapter.send(message),
  stopDebugging,
  startTerminal,
  writeTerminal,
  resizeTerminal,
  stopTerminal: (session: unknown) => stopTerminal(session ?? 'shell'),
  listAgents,
  glistStatus,
  aboutInfo,
  engineCheckout,
  updateEngine,
  installAgent: installAgentFromSettings,
  debuggerStatus,
  installDebugger: installDebuggerFromSettings,
  ...git.handlers,
  ...plugins,
};
