import { icon } from './icons';
import { t, type TranslationKey } from './localization';

// Settings > PATH: the folders programs started from the studio look in, in
// the order they look. The ones the studio brings are shown but cannot be
// changed; folders added here come last and can be removed again.

const storageKey = 'glist-studio-custom-path';

const sourceLabel: Record<GlistPathEntry['source'], TranslationKey> = {
  glist: 'pathGlist', cmake: 'pathCmake', system: 'pathSystem', git: 'pathGit', plugin: 'pathPlugin', custom: 'pathCustom',
};

const saved = (): string[] => {
  try {
    const folders = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as unknown;
    return Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string') : [];
  } catch {
    return [];
  }
};

export class PathSettings {
  private folders = saved();

  constructor(private readonly list: HTMLElement, add: HTMLButtonElement, private readonly error: HTMLElement) {
    void this.save(this.folders);
    add.addEventListener('click', () => { void this.add(); });
  }

  async refresh(): Promise<void> {
    const entries = await window.glistAPI.pathEntries().catch((): GlistPathEntry[] => []);
    this.list.replaceChildren(...entries.map((entry) => this.row(entry)));
  }

  private row(entry: GlistPathEntry): HTMLElement {
    const row = document.createElement('li');
    row.className = `path-entry ${entry.source}${entry.exists === false ? ' missing' : ''}`;
    const folder = document.createElement('span');
    folder.className = 'path-folder';
    folder.textContent = entry.path;
    folder.title = entry.exists === false ? `${entry.path}\n${t('pathMissing')}` : entry.path;
    const source = document.createElement('span');
    source.className = 'path-source';
    source.textContent = t(sourceLabel[entry.source]).replace('{name}', entry.owner);
    row.append(folder, source);
    if (entry.source === 'custom') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'path-remove';
      remove.title = t('removePathFolder');
      remove.setAttribute('aria-label', t('removePathFolder'));
      remove.append(icon('close'));
      remove.addEventListener('click', () => { void this.save(this.folders.filter((known) => known !== entry.path)); });
      row.append(remove);
    }
    return row;
  }

  private async add(): Promise<void> {
    this.error.textContent = '';
    const folder = await window.glistAPI.chooseFolder();
    if (!folder || this.folders.includes(folder)) return;
    const before = this.folders.length;
    // The backend keeps only whole folders; one it left out cannot be used.
    if ((await this.save([...this.folders, folder])).length === before) this.error.textContent = t('pathInvalid');
  }

  // What the backend kept is what is saved, so a folder is removed as it is listed.
  private async save(folders: string[]): Promise<string[]> {
    this.folders = await window.glistAPI.setCustomPath(folders).catch(() => this.folders);
    try { window.localStorage.setItem(storageKey, JSON.stringify(this.folders)); } catch { /* Storage may be unavailable. */ }
    await this.refresh();
    return this.folders;
  }
}
