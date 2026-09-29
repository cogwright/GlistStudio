import { notify, type NoticeAction } from './notifications';
import { t, type TranslationKey } from './localization';

// Git in the renderer: whether it is turned on, the repository's status, and
// running what changes it. Every view reads the status from here and is told
// when it changes.

const storageKey = 'glist-studio-git';
const updateKey = 'glist-studio-git-update';

export interface GitClientHooks {
  // Saves every changed tab, so what is committed or switched away from is what is on screen.
  saveAll(): Promise<boolean>;
  // Reads open files and the explorer again after git changed files on disk.
  reloadFiles(): Promise<void>;
  // The label beside the build status while something runs, or null when done.
  busy(label: string | null): void;
  showConsole(): void;
  showConflicts(): void;
}

export interface RunOptions {
  // Shown while it runs.
  busy?: TranslationKey;
  // Shown when it worked.
  success?: string;
  // Buttons for a failure, beside Show Console.
  failureActions?: (result: GlistGitResult) => NoticeAction[];
  // Failures the caller handles itself.
  quiet?: (result: GlistGitResult) => boolean;
}

// What leaves every file as it was, so open tabs need not be read again.
const keepsFiles = new Set<GlistGitAction['kind']>([
  'commit', 'create-tag', 'delete-tag', 'fetch', 'push', 'add-remote', 'remove-remote', 'set-remote-url', 'identity',
  'drop-stash', 'rename-branch', 'delete-branch',
]);

export class GitClient {
  status: GlistGitStatus | null = null;
  private listeners = new Set<(status: GlistGitStatus | null) => void>();
  private enabledListeners = new Set<(enabled: boolean) => void>();
  private refreshing: Promise<void> | null = null;
  private again = false;
  private changes = new Map<string, GlistGitChange>();
  private ignored: string[] = [];
  enabled: boolean;

  constructor(private readonly hooks: GitClientHooks) {
    try { this.enabled = window.localStorage.getItem(storageKey) === 'on'; } catch { this.enabled = false; }
    window.glistAPI.onGitChanged(() => { void this.refresh(); });
    window.addEventListener('focus', () => { void this.refresh(); });
  }

  get repository(): GlistGitRepository | null {
    return this.enabled ? this.status?.repository ?? null : null;
  }

  // How Update Project brings in commits: merging, or rebasing onto them.
  get updateByRebase(): boolean {
    try { return window.localStorage.getItem(updateKey) === 'rebase'; } catch { return false; }
  }

  set updateByRebase(rebase: boolean) {
    try { window.localStorage.setItem(updateKey, rebase ? 'rebase' : 'merge'); } catch { /* Storage may be unavailable. */ }
  }

  onStatus(listener: (status: GlistGitStatus | null) => void): void {
    this.listeners.add(listener);
  }

  onEnabled(listener: (enabled: boolean) => void): void {
    this.enabledListeners.add(listener);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    try { window.localStorage.setItem(storageKey, enabled ? 'on' : 'off'); } catch { /* Storage may be unavailable. */ }
    void window.glistAPI.gitWatch(enabled);
    this.enabledListeners.forEach((listener) => listener(enabled));
    if (enabled) void this.refresh();
    else this.publish(null);
  }

  // The change git has for a file, by its path as the explorer spells it.
  changeOf(filePath: string): GlistGitChange | undefined {
    return this.changes.get(filePath);
  }

  isIgnored(filePath: string): boolean {
    return this.ignored.some((entry) => filePath === entry || filePath.startsWith(entry) || `${filePath}/` === entry || `${filePath}\\` === entry);
  }

  // What a folder holds: changed files, only new ones, or neither.
  folderState(folder: string): 'changed' | 'untracked' | null {
    const prefix = folder.endsWith('/') || folder.endsWith('\\') ? folder : `${folder}${folder.includes('\\') ? '\\' : '/'}`;
    let state: 'changed' | 'untracked' | null = null;
    for (const [filePath, change] of this.changes) {
      if (!filePath.startsWith(prefix)) continue;
      if (change.state !== 'untracked') return 'changed';
      state = 'untracked';
    }
    return state;
  }

  // Runs again once more if asked while running, so the last change is always seen.
  refresh(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.again = false;
        try { this.publish(await window.glistAPI.gitStatus()); } catch { /* The next change tries again. */ }
      } while (this.again && this.enabled);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // The project changed: the status starts over. The backend moves its watcher itself.
  projectChanged(): Promise<void> {
    this.publish(null);
    return this.refresh();
  }

  async run(action: GlistGitAction, options: RunOptions = {}): Promise<GlistGitResult> {
    if (!(await this.hooks.saveAll())) return { success: false, message: t('saveFailed') };
    this.hooks.busy(options.busy ? t(options.busy) : t('gitWorking'));
    let result: GlistGitResult;
    try {
      result = await window.glistAPI.gitRun(action);
    } catch (error) {
      result = { success: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.hooks.busy(null);
    }
    if (!keepsFiles.has(action.kind)) await this.hooks.reloadFiles();
    await this.refresh();
    if (result.success) {
      if (options.success) notify({ text: options.success, kind: 'success' });
    } else if (!options.quiet?.(result)) {
      if (result.conflicts) {
        notify({ text: t('conflictsNotice'), kind: 'error', actions: [{ label: t('showConflicts'), run: () => this.hooks.showConflicts() }] });
      } else {
        notify({
          text: t('gitFailed'),
          detail: result.message,
          kind: 'error',
          actions: [...(options.failureActions?.(result) ?? []), { label: t('showConsole'), run: () => this.hooks.showConsole() }],
        });
      }
    }
    return result;
  }

  private publish(status: GlistGitStatus | null): void {
    this.status = status;
    this.changes = new Map((status?.repository?.changes ?? []).map((change) => [change.path, change]));
    this.ignored = status?.repository?.ignored ?? [];
    this.listeners.forEach((listener) => listener(this.enabled ? status : null));
  }
}

// A file's state, as a word for tooltips and a letter for lists.
export const stateText: Record<GlistGitFileState, TranslationKey> = {
  modified: 'stateModified',
  added: 'stateAdded',
  deleted: 'stateDeleted',
  renamed: 'stateRenamed',
  untracked: 'stateUntracked',
  conflict: 'stateConflict',
  typechange: 'stateTypechange',
};

export const stateLetter: Record<GlistGitFileState, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: 'C',
  typechange: 'T',
};
