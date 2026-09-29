interface GlistFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

declare module '*.ico' {
  const assetUrl: string;
  export default assetUrl;
}

// Codicons, as SVG markup.
declare module '@vscode/codicons/src/icons/*.svg' {
  const markup: string;
  export default markup;
}

// The engine or a plugin an app is built with. A plugin the app names may be
// missing from glistplugins.
interface GlistDependency {
  name: string;
  kind: 'engine' | 'plugin';
  path: string;
  exists: boolean;
}

// A project Open Project offers; lastOpened is when the studio last opened it.
interface GlistProjectSummary {
  root: string;
  name: string;
  // The root as shown, such as ~/dev/glist/myglistapps/MyApp.
  location: string;
  lastOpened?: number;
}

// A folder on PATH for the programs the studio starts, and where it comes from:
// Glist's compilers and tools, CMake's folder, this computer's system folders,
// Git for Windows, a plugin's DLLs (owner names it), or one added in Settings.
interface GlistPathEntry {
  path: string;
  source: 'glist' | 'cmake' | 'system' | 'git' | 'plugin' | 'custom';
  owner: string;
  exists?: boolean;
}

// A plugin in the Plugins view: one GlistPlugins publishes, one installed in glistplugins, or both.
interface GlistPlugin {
  name: string;
  description: string;
  // Its page on GitHub; empty for one GlistPlugins does not publish.
  url: string;
  installed: boolean;
  folder?: string;
  // Named in the open project's PLUGINS.
  used?: boolean;
  // A git repository, and whether its origin is GlistPlugins, the only kind updated from there.
  repository?: boolean;
  official?: boolean;
  branch?: string | null;
  defaultBranch?: string;
  // Files changed and not committed, commits of its own, and commits on GlistPlugins it does not have.
  changed?: number;
  ahead?: number;
  behind?: number;
}

interface GlistPluginList {
  plugins: GlistPlugin[];
  folder: string;
  gitFound: boolean;
  // Why GlistPlugins' list could not be read.
  error?: string;
}

interface GlistPluginResult {
  success: boolean;
  message: string;
  // An update would put the user's work aside: asked again with keep to go on.
  confirm?: { changed: number; ahead: number };
  // Where the user's work went: a stash, and a branch.
  kept?: { stash?: string; branch?: string };
}

interface GlistProjectInfo {
  root: string;
  name: string;
  hasCMakeProject: boolean;
}

interface GlistProcessResult {
  success: boolean;
  message: string;
}

// Where updating Glist Studio stands. "unavailable": this copy cannot update
// itself, being built from source or the browser version. "available": a newer
// version this copy cannot install in place, so only its page can help.
interface GlistUpdateState {
  state: 'unavailable' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'available' | 'failed';
  // The running version, and the new one.
  current?: string;
  version?: string;
  page?: string;
  message?: string;
}

// A target of the project's build, as CMake describes it.
interface GlistTarget {
  name: string;
  // Only executables run; libraries and utility targets are built.
  type: 'executable' | 'library' | 'utility';
  // Whose it is: the project's, the engine's, a plugin's, or from elsewhere.
  group: 'project' | 'engine' | 'plugin' | 'other';
  // The plugin's name, for a plugin's target.
  owner: string;
  // The project's app, which Build and Run use without a choice.
  app: boolean;
  artifact?: string;
}

// Settings > Debugger: the GDB Glist Studio installs on Windows, where Glist's tools have no debugger.
interface GlistDebuggerStatus {
  offered: boolean;
  installed: boolean;
  name: string;
  version: string;
  // Bytes to download.
  size: number;
}

// An environment variable set in Settings.
interface GlistVariable {
  name: string;
  value: string;
}

interface GlistDebugStart {
  success: boolean;
  // What the program is given, from Settings.
  args?: string[];
  // On Windows: there is none yet, and Settings can install one.
  missingDebugger?: boolean;
  // The debugger is the GDB Settings installed, which can be installed again if it fails.
  installedDebugger?: boolean;
  message: string;
  program?: string;
  cwd?: string;
  flavor?: 'lldb' | 'gdb';
}

interface GlistClangdStatus {
  running: boolean;
  message: string;
  // Whether the build directory had compile_commands.json when clangd started.
  compileCommands?: boolean;
}

type GlistTemplate = 'GlistApp' | 'GlistConsoleApp' | 'GlistGUIApp';

type GlistTerminalSession = 'shell' | 'agent' | 'install';
interface GlistInstallStatus {
  installed: boolean;
  // Where the install scripts put Glist: C:\dev\glist or ~/dev/glist.
  root: string;
  location: string;
  // How the installer asks for a password: a system dialog, the dialog's
  // terminal (Linux without a password dialog program), or not at all (Windows).
  passwordPrompt: 'system' | 'terminal' | 'none';
}
type GlistAgentId = 'claude' | 'codex' | 'gemini' | 'antigravity';
interface GlistAgentStatus {
  id: GlistAgentId;
  name: string;
  installed: boolean;
  // studio: installed from Settings; glist: shipped in Glist's zbin; system: on PATH.
  source?: 'studio' | 'glist' | 'system';
  location?: string;
  installable: boolean;
}
// Git, while it is turned on in Settings. Paths are absolute, spelled the way
// the project's own paths are, so they match the explorer's.
type GlistGitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'typechange';
interface GlistGitChange {
  path: string;
  // Where a renamed file came from.
  from?: string;
  state: GlistGitFileState;
  // For a conflict, git's two-letter code: UU both changed it, AA both added
  // it, UD or DU one side deleted it.
  conflict?: string;
}
// A merge, rebase, cherry-pick or revert that stopped to have conflicts resolved.
type GlistGitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';
interface GlistGitRepository {
  // The project's own repository, or the engine's or a plugin's the project is built with.
  kind: 'project' | 'engine' | 'plugin';
  // The project's, engine's or plugin's folder name.
  name: string;
  // The repository's top folder, which can be above the project's.
  root: string;
  // The folder the studio knows it by. An engine's or plugin's names its repository in calls.
  folder: string;
  location: string;
  aboveProject: boolean;
  // null while HEAD is detached.
  branch: string | null;
  // The commit HEAD is at; null before the first commit.
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: GlistGitOperation | null;
  // What the operation is about, such as "Merge branch 'feature'".
  operationSubject?: string;
  // Only within the project folder.
  changes: GlistGitChange[];
  // Ignored files and folders within the project; folders end in a separator.
  ignored: string[];
  stashes: number;
  // The project's, with protection on: HEAD's commit is on a remote branch already.
  headPushed?: boolean;
}
// Settings > Git: pushed commits are not amended, and these branches are not force pushed.
interface GlistGitProtection {
  on: boolean;
  // Names, or patterns such as release/*; GitHub's protected branches are added.
  branches: string[];
}
interface GlistGitStatus {
  // git's version, or null when git was not found.
  version: string | null;
  // null when the project is not in a repository.
  repository: GlistGitRepository | null;
  // The engine's and plugins' own repositories.
  dependencies: GlistGitRepository[];
  // Why git could not read the repository, such as a folder owned by another user.
  error?: string;
}
interface GlistGitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  // Seconds since the epoch.
  date: number;
  // Branches and tags pointing at it.
  refs: string[];
  subject: string;
}
interface GlistGitCommitFile {
  path: string;
  from?: string;
  state: GlistGitFileState;
}
interface GlistGitCommitDetails extends GlistGitCommit {
  committer: string;
  committerDate: number;
  message: string;
  // The commit its files are compared with: the first parent, or none for the first commit.
  base: string | null;
  files: GlistGitCommitFile[];
}
interface GlistGitLogQuery {
  // An engine's or plugin's folder; the project's repository when absent.
  root?: string;
  // A branch, tag or HEAD; every branch when absent.
  ref?: string;
  // Words from the message, or the start of a commit hash.
  text?: string;
  // One file's history.
  path?: string;
  skip?: number;
  limit?: number;
}
interface GlistGitBranch {
  // refs/heads/main or refs/remotes/origin/main
  ref: string;
  name: string;
  remote: boolean;
  current: boolean;
  commit: string;
  upstream: string | null;
  // The upstream branch was deleted.
  gone: boolean;
  ahead: number;
  behind: number;
  date: number;
  subject: string;
}
interface GlistGitTag {
  name: string;
  commit: string;
  date: number;
  subject: string;
}
interface GlistGitRemote {
  name: string;
  fetch: string;
  push: string;
}
interface GlistGitStash {
  // stash@{0}
  name: string;
  message: string;
  date: number;
}
interface GlistGitBlameLine {
  commit: string;
  author: string;
  date: number;
  summary: string;
  // Changed since the last commit.
  uncommitted: boolean;
}
// A file as a commit has it: text is null when the commit does not have the file.
interface GlistGitFileVersion {
  text: string | null;
  binary?: boolean;
  tooLarge?: boolean;
}
interface GlistGitIdentity {
  name: string;
  email: string;
  // The computer account's full name, offered when git has no name yet.
  suggestedName?: string;
}
interface GlistGitResult {
  success: boolean;
  message: string;
  // The operation stopped on conflicts to resolve.
  conflicts?: boolean;
  // Checking out stopped because local changes would be overwritten.
  localChanges?: boolean;
  // A branch that is not merged was not deleted.
  notMerged?: boolean;
  // Pushing was refused because the remote has commits this branch does not.
  rejected?: boolean;
}
// Everything that changes a repository goes through gitRun, one at a time.
type GlistGitAction =
  | { kind: 'init' }
  | { kind: 'commit'; message: string; paths: string[]; amend: boolean }
  | { kind: 'rollback'; paths: string[] }
  | { kind: 'ignore'; paths: string[] }
  | { kind: 'resolve'; path: string; side: 'mine' | 'theirs' }
  // Puts a resolved conflict back, markers and all.
  | { kind: 'unresolve'; path: string }
  | { kind: 'mark-resolved'; paths: string[] }
  | { kind: 'abort' }
  | { kind: 'continue' }
  | { kind: 'skip' }
  // A branch, a remote branch to check out as a local one, or a commit. Smart
  // stashes local changes that are in the way and brings them back after.
  | { kind: 'checkout'; ref: string; smart?: boolean }
  | { kind: 'create-branch'; name: string; start?: string; checkout: boolean }
  | { kind: 'rename-branch'; from: string; to: string }
  | { kind: 'delete-branch'; name: string; remote: boolean; force?: boolean }
  | { kind: 'merge'; ref: string }
  | { kind: 'rebase'; onto: string }
  | { kind: 'cherry-pick'; commit: string }
  | { kind: 'revert'; commit: string }
  | { kind: 'reset'; commit: string; mode: 'soft' | 'mixed' | 'hard' }
  | { kind: 'create-tag'; name: string; commit?: string; message?: string }
  | { kind: 'delete-tag'; name: string }
  | { kind: 'fetch' }
  | { kind: 'pull'; rebase: boolean }
  | { kind: 'push'; remote?: string; tags?: boolean; force?: boolean }
  | { kind: 'add-remote'; name: string; url: string }
  | { kind: 'remove-remote'; name: string }
  | { kind: 'set-remote-url'; name: string; url: string }
  | { kind: 'stash'; message?: string; untracked: boolean }
  | { kind: 'unstash'; name: string; pop: boolean }
  | { kind: 'drop-stash'; name: string }
  | { kind: 'identity'; name: string; email: string };
// A line of the Git console: a command, its output, or its failure.
interface GlistGitConsoleEntry {
  kind: 'command' | 'output' | 'error';
  text: string;
}
type GlistLanguage = 'en' | 'tr';
// The colors the window frame takes from the theme.
interface GlistWindowColors {
  kind: 'dark' | 'light';
  background: string;
  chrome: string;
  text: string;
}

interface Window {
  glistAPI: {
    openProject(): Promise<GlistProjectInfo | null>;
    createProject(templateName: GlistTemplate, projectName: string): Promise<GlistProjectInfo>;
    listDirectory(directoryPath: string): Promise<GlistFileEntry[]>;
    createFile(directoryPath: string, name: string): Promise<string>;
    createDirectory(directoryPath: string, name: string): Promise<string>;
    deleteEntry(entryPath: string): Promise<boolean>;
    renameEntry(entryPath: string, newName: string): Promise<string>;
    createCppClass(directoryPath: string, className: string): Promise<{ header: string; source: string }>;
    copyEntry(entryPath: string, destinationDirectory: string): Promise<string>;
    showInExplorer(entryPath: string): Promise<void>;
    openCommandPrompt(entryPath: string): Promise<void>;
    readFile(filePath: string): Promise<string>;
    readWorkspaceFile(filePath: string): Promise<string>;
    listDependencies(): Promise<GlistDependency[]>;
    listWorkspaceDirectory(directoryPath: string): Promise<GlistFileEntry[]>;
    getProjectsDirectory(): Promise<string>;
    listProjects(): Promise<GlistProjectSummary[]>;
    openProjectPath(root: string): Promise<GlistProjectInfo>;
    getPlatform(): Promise<string>;
    writeFile(filePath: string, contents: string): Promise<boolean>;
    buildProject(): Promise<GlistProcessResult>;
    runProject(): Promise<GlistProcessResult>;
    // The build's targets, configuring once if the build folder does not describe them yet.
    listTargets(): Promise<GlistTarget[]>;
    // The target Build, Run and Debug use; null for the app, built with everything.
    setTarget(name: string | null): Promise<void>;
    stopProject(): Promise<GlistProcessResult>;
    setLanguage(language: GlistLanguage): Promise<GlistLanguage>;
    // Settings > PATH: the folders programs started from the studio look in, in order.
    pathEntries(): Promise<GlistPathEntry[]>;
    // Returns the folders kept: whole absolute folders, each once.
    setCustomPath(folders: string[]): Promise<string[]>;
    // Returns the variables kept: valid names, PATH left to its own list, each name once.
    setCustomEnvironment(variables: GlistVariable[]): Promise<GlistVariable[]>;
    // For the open project; a new project starts without.
    setRunArguments(args: string[]): Promise<string[]>;
    chooseFolder(): Promise<string | null>;
    setTheme(colors: GlistWindowColors): Promise<void>;
    setZoomFactor(factor: number): Promise<number>;
    // Whether CMake configures again when its files change.
    setAutoConfigure(on: boolean): Promise<void>;
    openEngineSite(): Promise<void>;
    startClangd(): Promise<GlistClangdStatus>;
    sendClangd(message: unknown): Promise<void>;
    startDebugging(): Promise<GlistDebugStart>;
    sendDebug(message: unknown): Promise<void>;
    stopDebugging(): Promise<void>;
    debuggerStatus(): Promise<GlistDebuggerStatus>;
    // Again: removes the installed one first.
    installDebugger(again?: boolean): Promise<GlistProcessResult>;
    startTerminal(session: GlistTerminalSession, columns: number, rows: number, agent?: GlistAgentId): Promise<GlistProcessResult>;
    writeTerminal(session: GlistTerminalSession, data: string): Promise<void>;
    resizeTerminal(session: GlistTerminalSession, columns: number, rows: number): Promise<void>;
    stopTerminal(session: GlistTerminalSession): Promise<void>;
    listAgents(): Promise<GlistAgentStatus[]>;
    glistStatus(): Promise<GlistInstallStatus>;
    // The Plugins view; refresh asks GlistPlugins again rather than using the last answer.
    listPlugins(refresh?: boolean): Promise<GlistPluginList>;
    checkPluginUpdates(): Promise<GlistPlugin[]>;
    installPlugin(name: string): Promise<GlistPluginResult>;
    updatePlugin(name: string, keep?: boolean): Promise<GlistPluginResult>;
    usePlugin(name: string, use: boolean): Promise<GlistPluginResult>;
    updateState(): Promise<GlistUpdateState>;
    checkForUpdates(): Promise<GlistUpdateState>;
    // Quits, asking about unsaved files as usual, and installs the downloaded update.
    installUpdate(): Promise<void>;
    openUpdatePage(): Promise<void>;
    installAgent(agent: GlistAgentId): Promise<GlistProcessResult>;
    gitStatus(): Promise<GlistGitStatus>;
    gitWatch(on: boolean): Promise<void>;
    gitLog(query: GlistGitLogQuery): Promise<GlistGitCommit[]>;
    // root: an engine's or plugin's folder, or the project's repository when absent.
    gitCommitDetails(revision: string, root?: string): Promise<GlistGitCommitDetails>;
    gitBranches(root?: string): Promise<GlistGitBranch[]>;
    gitTags(root?: string): Promise<GlistGitTag[]>;
    gitRemotes(root?: string): Promise<GlistGitRemote[]>;
    gitStashes(root?: string): Promise<GlistGitStash[]>;
    gitFileAt(revision: string, filePath: string): Promise<GlistGitFileVersion>;
    gitBlame(filePath: string, contents: string): Promise<GlistGitBlameLine[]>;
    gitIdentity(): Promise<GlistGitIdentity>;
    gitLastMessage(root?: string): Promise<string>;
    // protected: the branch it goes to is protected, so it is never force pushed.
    gitOutgoing(root?: string): Promise<{ remote: string | null; branch: string | null; remotes: string[]; commits: GlistGitCommit[]; protected: boolean }>;
    gitProtection(protection: GlistGitProtection): Promise<void>;
    gitRun(action: GlistGitAction, root?: string): Promise<GlistGitResult>;
    gitClone(url: string, name: string): Promise<GlistProcessResult & { root?: string }>;
    onBuildOutput(callback: (text: string) => void): () => void;
    onBuildStatus(callback: (status: { running: boolean; label: string }) => void): () => void;
    onConfigured(callback: (result: GlistProcessResult) => void): () => void;
    onRunOutput(callback: (text: string) => void): () => void;
    onRunStatus(callback: (status: { running: boolean; exitCode?: number }) => void): () => void;
    onClangdMessage(callback: (message: unknown) => void): () => void;
    onClangdStatus(callback: (status: GlistClangdStatus) => void): () => void;
    // The compile commands clangd reads changed, after configuring.
    onCompileCommands(callback: () => void): () => void;
    onSaveAndClose(callback: () => void): () => void;
    onDebugMessage(callback: (message: unknown) => void): () => void;
    onDebugStatus(callback: (status: GlistClangdStatus) => void): () => void;
    onDebuggerInstall(callback: (text: string) => void): () => void;
    onTerminalData(callback: (event: { session: GlistTerminalSession; data: string }) => void): () => void;
    onTerminalExit(callback: (event: { session: GlistTerminalSession; exitCode: number }) => void): () => void;
    onAgentInstall(callback: (text: string) => void): () => void;
    onUpdateState(callback: (update: GlistUpdateState) => void): () => void;
    onGitChanged(callback: () => void): () => void;
    onGitConsole(callback: (entry: GlistGitConsoleEntry) => void): () => void;
  };
}
