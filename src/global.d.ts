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

// Monaco's Markdown renderer (see readme-page.ts), as far as the studio uses it.
declare module 'monaco-editor/base/browser/markdownRenderer.js' {
  export function renderMarkdown(
    markdown: { value: string; isTrusted?: boolean; supportHtml?: boolean; baseUri?: import('monaco-editor/editor/editor.api').UriComponents },
    options?: { actionHandler?: (link: string) => void },
  ): { element: HTMLElement; dispose(): void };
}

// The engine or a plugin an app is built with. A plugin the app names may be
// missing from glistplugins.
// What the editor takes from a .clang-format: tabs or spaces, the indent and
// tab widths, where lines end (0 for nowhere), and whether formatting is off.
// Which style C and C++ files are laid out in: Glist Studio's own, Glist
// Engine's; the project's .clang-format, with Glist Engine's where there is none; or none.
type GlistCodeStyleMode = 'glist' | 'project' | 'none';
interface GlistCodeStyle {
  file: string;
  // Glist Studio's own, for a file with no .clang-format above it.
  builtIn?: boolean;
  useTab: boolean;
  indentWidth: number;
  tabWidth: number;
  columnLimit: number;
  disabled: boolean;
}

interface GlistDependency {
  name: string;
  kind: 'engine' | 'plugin';
  path: string;
  exists: boolean;
}

// Find in Files: the text, how to match it, and where: the project, or all
// with the engine and the plugins it names.
interface GlistSearchQuery {
  text: string;
  matchCase?: boolean;
  wholeWords?: boolean;
  regex?: boolean;
  scope?: 'project' | 'all';
}

interface GlistFoundFile {
  path: string;
  // From its folder, with / between names.
  relative: string;
  // The project's, engine's or plugin's name.
  owner: string;
  kind: 'project' | 'engine' | 'plugin';
}

interface GlistSearchMatch {
  // 1-based.
  line: number;
  column: number;
  length: number;
  // The line without its indent, or the part of a long one around the match, and where the match starts in it.
  preview: string;
  previewStart: number;
}

interface GlistSearchResult {
  files: Array<GlistFoundFile & { matches: GlistSearchMatch[] }>;
  matches: number;
  // More matches were there than are given.
  limited: boolean;
  folders: Array<{ path: string; name: string; kind: GlistFoundFile['kind'] }>;
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
type GlistUpdateChoice = 'keep' | 'replace';
type GlistUpdateHow = 'fast-forward' | 'rebase' | 'merge';

// Where a copy of the engine or a plugin stands against where it is published.
interface GlistCheckout {
  // A Git checkout, and its remote that is the source (GlistEngine's,
  // GlistPlugins' or the listed one's), under any name, if one is.
  repository: boolean;
  remote?: string | null;
  branch?: string | null;
  defaultBranch?: string;
  head?: { hash: string; subject: string; date: number } | null;
  // Files changed and not committed, commits of its own, and commits on the source it does not have.
  changed?: number;
  ahead?: number;
  behind?: number;
  // The source's new commits, newest first, twenty at most.
  incoming?: Array<{ hash: string; subject: string }>;
  // How an update that keeps the user's commits brings the new ones in: a
  // merge once they are on a protected branch (pushedTo), a rebase otherwise.
  keepBy?: GlistUpdateHow;
  pushedTo?: string;
  // Why the source could not be asked for its new commits.
  fetchError?: string;
}

interface GlistCheckoutResult {
  success: boolean;
  message: string;
  upToDate?: boolean;
  // There is work of the user's own: asked again with a choice to go on.
  confirm?: { changed: number; ahead: number; keepBy: GlistUpdateHow; pushedTo?: string };
  // Nothing changed, unless asked to leave the conflict for the Git tools.
  conflicts?: boolean;
  how?: GlistUpdateHow | 'replace';
  // Where replaced work went: a stash, and a branch.
  kept?: { stash?: string; branch?: string };
  // Changed files that clashed with the new version, left in a stash by git.
  stashClash?: boolean;
}

interface GlistPlugin extends Omit<GlistCheckout, 'repository'> {
  name: string;
  description: string;
  // Its page on GitHub; empty for one the list does not have.
  url: string;
  // Where it is installed and updated from: GlistPlugins, or owner/name for one listed from elsewhere.
  source?: string;
  installed: boolean;
  folder?: string;
  // Named in the open project's PLUGINS.
  used?: boolean;
  // A git repository, and whether one of its remotes is its source, the only kind updated from there.
  repository?: boolean;
  official?: boolean;
}

interface GlistPluginList {
  plugins: GlistPlugin[];
  folder: string;
  gitFound: boolean;
  // Why GlistPlugins' list could not be read.
  error?: string;
}

// A plugin's README, as Markdown, empty when it has none; page is its folder on
// GitHub, which its relative links and images lead to.
interface GlistPluginReadme {
  text: string;
  page: string;
}

interface GlistPluginResult {
  success: boolean;
  message: string;
}

// The engine beside the open project, or where Glist is installed.
interface GlistEngineCheckout extends GlistCheckout {
  folder: string;
  location: string;
  found: boolean;
}

// The title bar's menus, for macOS's own menu bar: the words shown, and the
// ids sent back when an item is chosen. Undo and redo are the system's own.
interface GlistAppMenuItem {
  kind: 'item' | 'separator' | 'heading';
  id?: string;
  label?: string;
  // As the menus write it: Ctrl+S, Shift+F5, Control+`.
  shortcut?: string;
  enabled?: boolean;
  role?: 'undo' | 'redo';
}
interface GlistAppMenu {
  name: string;
  label: string;
  items: GlistAppMenuItem[];
}
// The system's items in the words of the studio's language.
type GlistAppMenuWords = Record<'about' | 'settings' | 'services' | 'hide' | 'hideOthers' | 'showAll' | 'quit' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'window' | 'minimize' | 'zoom' | 'front', string>;

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
// Settings > About: which Glist Studio this is, and where the engine and the open
// project's plugins stand. Branch is null when a commit is checked out.
interface GlistAboutRepository {
  name: string;
  kind: 'engine' | 'plugin';
  location: string;
  found: boolean;
  // Absent when the folder is not a Git checkout.
  head?: { branch: string | null; commit: string | null; commitPage?: string };
}
interface GlistAbout {
  version: string;
  head: { branch: string | null; commit: string | null; commitPage?: string } | null;
  repositories: GlistAboutRepository[];
  runtime: Array<{ name: string; version: string }>;
}
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
// am is a patch being applied as commits (Apply Patch).
type GlistGitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am';

// Commits or changes as a patch to share, and a file name for it.
interface GlistGitPatch {
  patch: string;
  name: string;
  // How many commits it holds; 0 for changes not committed yet.
  commits: number;
}
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
  // The commit it is in, when not the one shown: a stash's new files.
  at?: string;
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
  | { kind: 'apply-patch'; patch: string }
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
  // Only the paths given, when there are any.
  | { kind: 'stash'; message?: string; untracked: boolean; paths?: string[] }
  | { kind: 'drop-commit'; commit: string }
  | { kind: 'unstash'; name: string; pop: boolean }
  | { kind: 'drop-stash'; name: string }
  | { kind: 'identity'; name: string; email: string };
// A line of the Git console: a command, its output, or its failure.
interface GlistGitConsoleEntry {
  kind: 'command' | 'output' | 'error';
  text: string;
  // A command that ended with this code, which the window puts in words.
  code?: number;
}
type GlistLanguage = import('./languages').Language;
// The colors the window frame takes from the theme.
interface GlistWindowColors {
  kind: 'dark' | 'light';
  background: string;
  chrome: string;
  text: string;
}

interface Window {
  // Electron only: where a file dropped from the system's file manager is. A browser does not say.
  glistFiles?: {
    pathForFile(file: File): string;
  };
  glistAPI: {
    openProject(): Promise<GlistProjectInfo | null>;
    createProject(templateName: GlistTemplate, projectName: string): Promise<GlistProjectInfo>;
    listDirectory(directoryPath: string): Promise<GlistFileEntry[]>;
    createFile(directoryPath: string, name: string): Promise<string>;
    createDirectory(directoryPath: string, name: string): Promise<string>;
    deleteEntry(entryPath: string): Promise<boolean>;
    renameEntry(entryPath: string, newName: string): Promise<string>;
    // Into another folder of the project, keeping its name.
    moveEntry(entryPath: string, destinationDirectory: string): Promise<string>;
    createCppClass(directoryPath: string, className: string): Promise<{ header: string; source: string }>;
    copyEntry(entryPath: string, destinationDirectory: string): Promise<string>;
    // Files and folders dropped from the system's file manager, by path; what is copied, where.
    importPaths(sources: string[], destinationDirectory: string): Promise<string[]>;
    // The same by content, from a browser: each file's place in what was dropped and its bytes in base64.
    importFiles(destinationDirectory: string, files: Array<{ path: string; data: string }>): Promise<string[]>;
    showInExplorer(entryPath: string): Promise<void>;
    readFile(filePath: string): Promise<string>;
    readWorkspaceFile(filePath: string): Promise<string>;
    // The .clang-format a C or C++ file follows, or null.
    codeStyle(filePath: string, mode?: GlistCodeStyleMode): Promise<GlistCodeStyle | null>;
    listDependencies(): Promise<GlistDependency[]>;
    // Find in Files; a new search stops the one before.
    searchText(query: GlistSearchQuery): Promise<GlistSearchResult>;
    // The project's files, and the engine's and plugins' with dependencies.
    listFiles(dependencies: boolean): Promise<GlistFoundFile[]>;
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
    // GlistEngine/GlistEngine on GitHub, to star.
    openEngineRepository(): Promise<void>;
    startClangd(): Promise<GlistClangdStatus>;
    sendClangd(message: unknown): Promise<void>;
    startDebugging(): Promise<GlistDebugStart>;
    sendDebug(message: unknown): Promise<void>;
    stopDebugging(): Promise<void>;
    debuggerStatus(): Promise<GlistDebuggerStatus>;
    // Again: removes the installed one first.
    installDebugger(again?: boolean): Promise<GlistProcessResult>;
    startTerminal(
      session: GlistTerminalSession, columns: number, rows: number, directory?: string, agent?: GlistAgentId,
    ): Promise<GlistProcessResult>;
    writeTerminal(session: GlistTerminalSession, data: string): Promise<void>;
    resizeTerminal(session: GlistTerminalSession, columns: number, rows: number): Promise<void>;
    stopTerminal(session: GlistTerminalSession): Promise<void>;
    listAgents(): Promise<GlistAgentStatus[]>;
    glistStatus(): Promise<GlistInstallStatus>;
    aboutInfo(): Promise<GlistAbout>;
    // True where the menus went to the system's menu bar, on macOS.
    setAppMenu(menus: GlistAppMenu[], words: GlistAppMenuWords): Promise<boolean>;
    onMenuCommand(callback: (id: string) => void): () => void;
    // The Plugins view; refresh asks GlistPlugins again rather than using the last answer.
    listPlugins(refresh?: boolean): Promise<GlistPluginList>;
    checkPluginUpdates(): Promise<GlistPlugin[]>;
    installPlugin(name: string): Promise<GlistPluginResult>;
    // Resolve leaves a conflict for the Git tools instead of taking the update back.
    updatePlugin(name: string, choice?: GlistUpdateChoice, resolve?: boolean): Promise<GlistCheckoutResult>;
    // The engine's state against GlistEngine; refresh fetches first.
    engineCheckout(refresh?: boolean): Promise<GlistEngineCheckout>;
    updateEngine(choice?: GlistUpdateChoice, resolve?: boolean): Promise<GlistCheckoutResult>;
    usePlugin(name: string, use: boolean): Promise<GlistPluginResult>;
    pluginReadme(name: string): Promise<GlistPluginReadme>;
    updateState(): Promise<GlistUpdateState>;
    // Previews: prereleases too.
    checkForUpdates(previews?: boolean): Promise<GlistUpdateState>;
    // Quits, asking about unsaved files as usual, and installs the downloaded update.
    installUpdate(): Promise<void>;
    openUpdatePage(): Promise<void>;
    installAgent(agent: GlistAgentId): Promise<GlistProcessResult>;
    gitStatus(): Promise<GlistGitStatus>;
    gitWatch(on: boolean): Promise<void>;
    gitLog(query: GlistGitLogQuery): Promise<GlistGitCommit[]>;
    // The current branch's commits no remote has yet, newest first.
    gitUnpublished(root?: string): Promise<string[]>;
    // root: an engine's or plugin's folder, or the project's repository when absent.
    gitCommitDetails(revision: string, root?: string): Promise<GlistGitCommitDetails>;
    // Commits, or changed files, of a repository as a patch.
    gitPatch(request: { root?: string; commits?: string[]; paths?: string[] }): Promise<GlistGitPatch>;
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
