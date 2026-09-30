// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';
import { fileIconElement } from './file-icons';
import { editorFonts, loadFonts, onFontsChange } from './fonts';
import { icon, type IconName } from './icons';
import { t, type TranslationKey } from './localization';
import { baseName } from './paths';
import { findInText, queryPattern } from './text-search';

// Find in Files, as CLion has it on Ctrl+Shift+F: text in every file of the
// project, or of the engine and plugins too, each match on a line of its own
// with the code around the chosen one below. Files with changes not saved yet
// are searched as the editor has them.

export interface FindInFilesHooks {
  search(query: GlistSearchQuery): Promise<GlistSearchResult>;
  // Open files with changes not saved yet, as the editor has them.
  unsaved(): Array<{ path: string; text: string }>;
  // A file's text as a model, for the preview.
  model(filePath: string): Promise<monaco.editor.ITextModel | null>;
  open(filePath: string, range: monaco.IRange): void;
  // The text selected in the editor, when it is on one line.
  selection(): string;
}

type Option = 'matchCase' | 'wholeWords' | 'regex';
type FoundFile = GlistSearchResult['files'][number];
interface Row { file: FoundFile; match: GlistSearchMatch }

const storageKey = 'glist-studio-find-in-files';
const toggles: Array<{ option: Option; icon: IconName; title: TranslationKey }> = [
  { option: 'matchCase', icon: 'case-sensitive', title: 'findMatchCase' },
  { option: 'wholeWords', icon: 'whole-word', title: 'findWholeWords' },
  { option: 'regex', icon: 'regex', title: 'findRegex' },
];

const inside = (folder: string, filePath: string): boolean =>
  filePath.startsWith(`${folder}/`) || filePath.startsWith(`${folder}\\`);

const fill = (key: TranslationKey, values: Record<string, string | number>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), t(key));

export class FindInFiles {
  private readonly dialog = document.createElement('dialog');
  private readonly input = document.createElement('input');
  private readonly buttons = new Map<Option, HTMLButtonElement>();
  private readonly scope = document.createElement('select');
  private readonly status = document.createElement('div');
  private readonly list = document.createElement('div');
  private readonly previewTitle = document.createElement('div');
  private readonly previewHost = document.createElement('div');
  private preview: monaco.editor.IStandaloneCodeEditor | null = null;
  private highlights: monaco.editor.IEditorDecorationsCollection | null = null;
  private rows: Row[] = [];
  private selected = -1;
  private ticket = 0;
  private timer = 0;
  private settings: Record<Option, boolean> & { text: string; scope: 'project' | 'all' } = {
    text: '', matchCase: false, wholeWords: false, regex: false, scope: 'project',
  };

  constructor(private readonly hooks: FindInFilesHooks) {
    try { Object.assign(this.settings, JSON.parse(window.localStorage.getItem(storageKey) ?? '{}')); } catch { /* Kept from an older version, or none. */ }
    this.dialog.className = 'find-in-files';
    const bar = document.createElement('div');
    bar.className = 'find-bar';
    this.input.type = 'text';
    this.input.className = 'find-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('aria-controls', 'find-results');
    const options = document.createElement('div');
    options.className = 'find-options';
    toggles.forEach(({ option, icon: name }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'find-toggle';
      button.append(icon(name));
      button.addEventListener('click', () => {
        this.settings[option] = !this.settings[option];
        this.showOptions();
        void this.search();
        this.input.focus();
      });
      this.buttons.set(option, button);
      options.append(button);
    });
    this.scope.className = 'find-scope';
    this.scope.addEventListener('change', () => {
      this.settings.scope = this.scope.value === 'all' ? 'all' : 'project';
      void this.search();
      this.input.focus();
    });
    bar.append(this.input, options, this.scope);
    this.status.className = 'find-status';
    this.status.setAttribute('role', 'status');
    this.list.id = 'find-results';
    this.list.className = 'find-results';
    this.list.setAttribute('role', 'listbox');
    const previewPane = document.createElement('div');
    previewPane.className = 'find-preview';
    this.previewTitle.className = 'find-preview-title';
    this.previewHost.className = 'find-preview-editor';
    previewPane.append(this.previewTitle, this.previewHost);
    this.dialog.append(bar, this.status, this.list, previewPane);
    document.body.append(this.dialog);

    this.input.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => { void this.search(); }, 200);
    });
    this.input.addEventListener('keydown', (event) => this.onKey(event));
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.dialog.close(); });
    // The preview lets go of its file, which may be one nobody has open.
    this.dialog.addEventListener('close', () => {
      window.clearTimeout(this.timer);
      this.ticket += 1;
      this.preview?.setModel(null);
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(): void {
    const selection = this.hooks.selection();
    if (selection) this.settings.text = selection;
    this.input.value = this.settings.text;
    this.input.placeholder = t('findInFilesPlaceholder');
    this.input.setAttribute('aria-label', t('findInFiles'));
    this.scope.replaceChildren(new Option(t('findScopeProject'), 'project'), new Option(t('findScopeAll'), 'all'));
    this.scope.value = this.settings.scope;
    this.showOptions();
    this.dialog.showModal();
    this.createPreview();
    this.input.focus();
    this.input.select();
    void this.search();
  }

  private createPreview(): void {
    if (this.preview) return;
    this.preview = monaco.editor.create(this.previewHost, {
      model: null,
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      glyphMargin: false,
      folding: false,
      lineNumbersMinChars: 4,
      renderLineHighlight: 'none',
      contextmenu: false,
      padding: { top: 6, bottom: 6 },
      ...editorFonts(loadFonts()),
    });
    onFontsChange((fonts) => this.preview?.updateOptions(editorFonts(fonts)));
    this.highlights = this.preview.createDecorationsCollection();
  }

  private showOptions(): void {
    toggles.forEach(({ option, title }) => {
      const button = this.buttons.get(option);
      if (!button) return;
      button.title = t(title);
      button.setAttribute('aria-label', t(title));
      button.setAttribute('aria-pressed', String(this.settings[option]));
      button.classList.toggle('on', this.settings[option]);
    });
    try { window.localStorage.setItem(storageKey, JSON.stringify(this.settings)); } catch { /* Storage may be unavailable. */ }
  }

  private query(): GlistSearchQuery {
    return {
      text: this.input.value, matchCase: this.settings.matchCase, wholeWords: this.settings.wholeWords,
      regex: this.settings.regex, scope: this.settings.scope,
    };
  }

  private async search(): Promise<void> {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.ticket += 1;
    const ticket = this.ticket;
    this.settings.text = this.input.value;
    this.showOptions();
    const query = this.query();
    let pattern: RegExp | null;
    try { pattern = queryPattern(query); } catch {
      this.show([], t('findInvalidRegex'), true);
      return;
    }
    if (!pattern) { this.show([], ''); return; }
    this.status.textContent = t('findSearching');
    this.status.classList.remove('error');
    let result: GlistSearchResult;
    try {
      result = await this.hooks.search(query);
    } catch (error) {
      if (ticket === this.ticket) this.show([], error instanceof Error ? error.message : String(error), true);
      return;
    }
    if (ticket !== this.ticket || !this.dialog.open) return;
    const files = this.withUnsaved(result, pattern);
    const count = files.reduce((sum, file) => sum + file.matches.length, 0);
    const summary = count === 0 ? t('findNothing') : fill('findSummary', {
      matches: count === 1 ? t('findOneMatch') : fill('findMatches', { count }),
      files: files.length === 1 ? t('findOneFile') : fill('findFiles', { count: files.length }),
    });
    this.show(files.flatMap((file) => file.matches.map((match) => ({ file, match }))),
      result.limited ? `${summary} ${fill('findLimited', { count })}` : summary);
  }

  // The files open with changes not saved yet, as the editor has them rather than as saved.
  private withUnsaved(result: GlistSearchResult, pattern: RegExp): FoundFile[] {
    const files = [...result.files];
    for (const { path: filePath, text } of this.hooks.unsaved()) {
      const folder = result.folders.find((candidate) => inside(candidate.path, filePath));
      if (!folder) continue;
      const matches = findInText(text, pattern, 2000);
      const at = files.findIndex((file) => file.path === filePath);
      if (at >= 0 && matches.length > 0) files[at] = { ...files[at], matches };
      else if (at >= 0) files.splice(at, 1);
      else if (matches.length > 0) {
        const relative = filePath.slice(folder.path.length + 1).replace(/\\/g, '/');
        files.push({ path: filePath, relative, owner: folder.name, kind: folder.kind, matches });
      }
    }
    const order = (file: FoundFile): number => result.folders.findIndex((folder) => folder.name === file.owner);
    return files.sort((left, right) => order(left) - order(right) || (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  }

  private show(rows: Row[], status: string, error = false): void {
    this.rows = rows;
    this.status.textContent = status;
    this.status.classList.toggle('error', error);
    this.list.replaceChildren(...rows.map((row, index) => this.rowElement(row, index)));
    this.select(rows.length > 0 ? 0 : -1);
  }

  private rowElement({ file, match }: Row, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'find-row';
    row.setAttribute('role', 'option');
    const text = document.createElement('span');
    text.className = 'find-row-text';
    const found = document.createElement('mark');
    found.textContent = match.preview.slice(match.previewStart, match.previewStart + match.length);
    text.append(match.preview.slice(0, match.previewStart), found, match.preview.slice(match.previewStart + match.length));
    const place = document.createElement('span');
    place.className = 'find-row-place';
    place.title = `${file.owner}/${file.relative}`;
    place.append(fileIconElement(baseName(file.relative)), `${baseName(file.relative)} ${match.line}`);
    row.append(text, place);
    row.addEventListener('click', () => this.select(index));
    row.addEventListener('dblclick', () => this.openRow(index));
    return row;
  }

  private onKey(event: KeyboardEvent): void {
    const page = Math.max(1, Math.floor(this.list.clientHeight / 24) - 1);
    const steps: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (event.key in steps && this.rows.length > 0) {
      event.preventDefault();
      this.select(Math.min(this.rows.length - 1, Math.max(0, this.selected + steps[event.key])));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // Typed faster than the search: this text first.
      if (this.timer) { void this.search(); return; }
      this.openRow(this.selected);
    }
  }

  private openRow(index: number): void {
    const row = this.rows[index];
    if (!row) return;
    this.dialog.close();
    this.hooks.open(row.file.path, this.range(row.match));
  }

  private range(match: GlistSearchMatch): monaco.IRange {
    return { startLineNumber: match.line, startColumn: match.column, endLineNumber: match.line, endColumn: match.column + match.length };
  }

  private select(index: number): void {
    this.selected = index;
    [...this.list.children].forEach((row, at) => {
      row.classList.toggle('selected', at === index);
      row.setAttribute('aria-selected', String(at === index));
    });
    this.list.children[index]?.scrollIntoView({ block: 'nearest' });
    void this.showPreview(this.rows[index]);
  }

  private async showPreview(row: Row | undefined): Promise<void> {
    const ticket = this.ticket;
    if (!row) {
      this.previewTitle.textContent = '';
      this.preview?.setModel(null);
      return;
    }
    this.previewTitle.textContent = `${row.file.owner}/${row.file.relative}`;
    const model = await this.hooks.model(row.file.path);
    if (ticket !== this.ticket || this.rows[this.selected] !== row || !this.preview) return;
    if (this.preview.getModel() !== model) this.preview.setModel(model);
    if (!model) return;
    const current = this.range(row.match);
    this.highlights?.set(row.file.matches.map((match) => ({
      range: this.range(match),
      options: { inlineClassName: match === row.match ? 'find-preview-current' : 'find-preview-match' },
    })));
    this.preview.revealRangeInCenter(current);
  }
}
