import type { PaletteCommand } from './command-palette';
import { searchCommands } from './command-search';
import { fileIconElement } from './file-icons';
import { fuzzyMatch, type FuzzyMatch } from './fuzzy';
import { icon, type IconName } from './icons';
import { t, type TranslationKey } from './localization';
import { baseName } from './paths';
import { shortcutLabel } from './shortcuts';

// Search Everywhere, as CLion has it on a double Shift: files by name, the
// classes, functions and other symbols clangd knows in the project, the engine
// and its plugins, and the studio's commands, in one list or one kind at a
// time. Tab moves between the kinds. "name:line" opens a file at a line.

export type SearchTab = 'all' | 'files' | 'symbols' | 'commands';

export interface SymbolHit {
  name: string;
  // The language server's SymbolKind.
  kind: number;
  container: string;
  path: string;
  // 0-based, as the language server counts.
  line: number;
  character: number;
  // The project's, the engine's or a plugin's, or the system's, such as the standard library's.
  place: 'project' | 'glist' | 'system';
}

export interface SearchEverywhereHooks {
  files(): Promise<GlistFoundFile[]>;
  // Files open in tabs, the one in front first, for before anything is typed.
  recent(): string[];
  // Best first; 'build' before the project's first build, 'off' without clangd.
  symbols(query: string): Promise<SymbolHit[] | 'build' | 'off'>;
  // What a symbol is declared as, such as its function's parameters.
  signature(hit: SymbolHit): Promise<string>;
  commands(): PaletteCommand[];
  openFile(filePath: string, line?: number, column?: number): void;
}

interface Entry {
  // The same result keeps the selection when the list is drawn again.
  key: string;
  element: HTMLElement;
  run?: () => void;
}

const tabs: Array<{ tab: SearchTab; label: TranslationKey }> = [
  { tab: 'all', label: 'searchAll' },
  { tab: 'files', label: 'searchFiles' },
  { tab: 'symbols', label: 'searchSymbols' },
  { tab: 'commands', label: 'searchCommands' },
];

// How many of each kind All shows before a "More" row.
const allLimits = { files: 6, symbols: 8, commands: 6 };

const symbolIcons: Record<number, IconName> = {
  2: 'symbol-namespace', 3: 'symbol-namespace', 4: 'symbol-namespace', 5: 'symbol-class', 6: 'symbol-method',
  7: 'symbol-property', 8: 'symbol-field', 9: 'symbol-method', 10: 'symbol-enum', 11: 'symbol-interface',
  12: 'symbol-method', 13: 'symbol-variable', 14: 'symbol-constant', 22: 'symbol-enum-member', 23: 'symbol-structure',
  24: 'symbol-event', 25: 'symbol-operator', 26: 'symbol-parameter',
};
// Colored as VS Code colors them: types orange, functions purple, data blue.
const symbolColors: Record<number, string> = {
  5: 'type', 10: 'type', 11: 'type', 23: 'type', 6: 'function', 9: 'function', 12: 'function', 25: 'function',
  7: 'data', 8: 'data', 13: 'data', 14: 'data', 22: 'data', 26: 'data',
};

const span = (className: string, text = ''): HTMLSpanElement => Object.assign(document.createElement('span'), { className, textContent: text });

// The name with the typed letters marked.
const marked = (text: string, positions: number[]): HTMLSpanElement => {
  const name = span('search-name');
  const chosen = new Set(positions);
  [...text].forEach((letter, index) => {
    if (chosen.has(index)) name.append(Object.assign(document.createElement('b'), { textContent: letter }));
    else name.append(letter);
  });
  return name;
};

const folderOf = (file: GlistFoundFile): string => {
  const folder = file.relative.split('/').slice(0, -1).join('/');
  return [file.owner, folder].filter(Boolean).join('/');
};

export class SearchEverywhere {
  private readonly dialog = document.createElement('dialog');
  private readonly tabBar = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly list = document.createElement('div');
  private tab: SearchTab = 'all';
  private files: GlistFoundFile[] | null = null;
  private symbols: { query: string; result: SymbolHit[] | 'build' | 'off' } | null = null;
  private entries: Entry[] = [];
  private selected = -1;
  private ticket = 0;
  private timer = 0;

  constructor(private readonly hooks: SearchEverywhereHooks) {
    this.dialog.className = 'command-palette search-everywhere';
    this.tabBar.className = 'search-tabs';
    this.tabBar.setAttribute('role', 'tablist');
    this.input.type = 'text';
    this.input.className = 'command-palette-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-controls', 'search-everywhere-list');
    this.input.setAttribute('aria-expanded', 'true');
    this.list.id = 'search-everywhere-list';
    this.list.className = 'command-palette-list';
    this.list.setAttribute('role', 'listbox');
    this.dialog.append(this.tabBar, this.input, this.list);
    document.body.append(this.dialog);
    this.input.addEventListener('input', () => this.changed());
    this.input.addEventListener('keydown', (event) => this.onKey(event));
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.dialog.close(); });
    this.dialog.addEventListener('close', () => { window.clearTimeout(this.timer); this.ticket += 1; });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(tab: SearchTab = 'all'): void {
    this.tab = tab;
    this.files = null;
    this.symbols = null;
    this.input.placeholder = t('searchEverywherePlaceholder');
    this.input.setAttribute('aria-label', t('searchEverywhere'));
    this.dialog.showModal();
    this.input.focus();
    this.input.select();
    const ticket = this.ticket;
    void this.hooks.files().catch((): GlistFoundFile[] => []).then((files) => {
      if (ticket !== this.ticket) return;
      this.files = files;
      this.render();
    });
    this.changed();
  }

  private query(): { text: string; line?: number } {
    const typed = this.input.value.trim();
    // gCanvas.cpp:20 is gCanvas.cpp at line 20.
    const at = /^(.*?):(\d+)$/.exec(typed);
    return at ? { text: at[1], line: Number(at[2]) } : { text: typed };
  }

  private changed(): void {
    this.render();
    window.clearTimeout(this.timer);
    const { text } = this.query();
    if (!text || this.tab === 'files' || this.tab === 'commands') return;
    const ticket = this.ticket;
    this.timer = window.setTimeout(() => {
      void this.hooks.symbols(text).catch((): 'off' => 'off').then((result) => {
        if (ticket !== this.ticket || this.query().text !== text) return;
        this.symbols = { query: text, result };
        this.render();
      });
    }, 120);
  }

  private showTab(tab: SearchTab): void {
    this.tab = tab;
    this.changed();
    this.input.focus();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      event.preventDefault();
      const at = tabs.findIndex((entry) => entry.tab === this.tab);
      this.showTab(tabs[(at + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length].tab);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.entries[this.selected]?.run?.();
    }
  }

  private move(step: number): void {
    const runnable = this.entries.flatMap((entry, index) => (entry.run ? [index] : []));
    if (runnable.length === 0) return;
    const at = runnable.indexOf(this.selected);
    this.selected = at < 0 ? runnable[0] : runnable[(at + step + runnable.length) % runnable.length];
    this.mark();
  }

  // Closed first, so focus is back where it was when the result is opened.
  private choose(run: () => void): () => void {
    return () => {
      this.dialog.close();
      run();
    };
  }

  private render(): void {
    const keep = this.entries[this.selected]?.key;
    this.tabBar.replaceChildren(...tabs.map(({ tab, label }) => {
      const button = Object.assign(document.createElement('button'), { type: 'button', className: 'search-tab', textContent: t(label) });
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(tab === this.tab));
      button.classList.toggle('active', tab === this.tab);
      button.addEventListener('click', () => this.showTab(tab));
      return button;
    }));
    const all = this.tab === 'all';
    const entries: Entry[] = [];
    const heading = (label: TranslationKey): void => {
      if (all) entries.push({ key: `heading:${label}`, element: span('search-heading', t(label)) });
    };
    const more = (tab: SearchTab, label: TranslationKey): void => {
      const row = this.row(span('search-more', t(label)));
      entries.push({ key: `more:${tab}`, element: row, run: () => this.showTab(tab) });
    };
    const note = (key: TranslationKey): void => { entries.push({ key: `note:${key}`, element: span('search-note', t(key)) }); };

    if (all || this.tab === 'files') {
      const files = this.fileEntries(all ? allLimits.files : 100);
      if (files.entries.length > 0) {
        heading('searchFiles');
        entries.push(...files.entries);
        if (files.more && all) more('files', 'searchMoreFiles');
      }
    }
    if (all || this.tab === 'symbols') {
      const symbols = this.symbolEntries(all ? allLimits.symbols : 100);
      if (symbols.entries.length > 0) {
        heading('searchSymbols');
        entries.push(...symbols.entries);
        if (symbols.more && all) more('symbols', 'searchMoreSymbols');
      } else if (symbols.note && (!all || this.query().text)) {
        heading('searchSymbols');
        note(symbols.note);
      }
    }
    if (all || this.tab === 'commands') {
      const commands = this.commandEntries(all ? allLimits.commands : Infinity);
      if (commands.entries.length > 0) {
        heading('searchCommands');
        entries.push(...commands.entries);
        if (commands.more && all) more('commands', 'searchMoreCommands');
      }
    }
    if (!entries.some((entry) => entry.run)) {
      entries.length = 0;
      note(this.query().text ? 'searchNothing' : 'searchEverywhereHint');
    }
    this.entries = entries;
    this.list.replaceChildren(...entries.map((entry) => entry.element));
    const kept = entries.findIndex((entry) => entry.run && entry.key === keep);
    this.selected = kept >= 0 ? kept : entries.findIndex((entry) => entry.run);
    this.mark();
  }

  private row(...parts: Node[]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'command-palette-row search-row';
    row.setAttribute('role', 'option');
    row.append(...parts);
    return row;
  }

  private entry(key: string, run: () => void, ...parts: Node[]): Entry {
    const element = this.row(...parts);
    const chosen = this.choose(run);
    element.addEventListener('click', chosen);
    return { key, element, run: chosen };
  }

  private fileEntries(limit: number): { entries: Entry[]; more: boolean } {
    const { text, line } = this.query();
    const fileRow = (file: GlistFoundFile, match: FuzzyMatch | null): Entry => this.entry(
      `file:${file.path}`,
      () => this.hooks.openFile(file.path, line),
      fileIconElement(baseName(file.relative)),
      match ? marked(baseName(file.relative), match.positions) : span('search-name', baseName(file.relative)),
      span('search-detail', folderOf(file)),
    );
    if (!text) {
      if (this.tab !== 'all' && this.tab !== 'files') return { entries: [], more: false };
      const known = new Map((this.files ?? []).map((file) => [file.path, file]));
      const recent = this.hooks.recent().map((filePath) => known.get(filePath) ?? { path: filePath, relative: baseName(filePath), owner: '', kind: 'project' as const });
      return { entries: recent.slice(0, limit).map((file) => fileRow(file, null)), more: recent.length > limit };
    }
    if (!this.files) return { entries: [], more: false };
    // By name; by where it is too once a / is typed.
    const byPath = /[\\/]/.test(text);
    const scored = this.files.flatMap((file) => {
      const match = fuzzyMatch(byPath ? text.replace(/\\/g, '/') : text, byPath ? `${file.owner}/${file.relative}` : baseName(file.relative));
      // The project's own before the engine's and plugins'.
      return match ? [{ file, match, score: match.score + (file.kind === 'project' ? 0.5 : 0) }] : [];
    }).sort((left, right) => right.score - left.score || left.file.relative.length - right.file.relative.length);
    return {
      entries: scored.slice(0, limit).map(({ file, match }) => fileRow(file, byPath ? null : match)),
      more: scored.length > limit,
    };
  }

  private symbolEntries(limit: number): { entries: Entry[]; more: boolean; note?: TranslationKey } {
    const { text } = this.query();
    if (!text) return { entries: [], more: false, note: 'searchSymbolsHint' };
    const result = this.symbols?.result;
    if (result === 'build') return { entries: [], more: false, note: 'searchSymbolsBuild' };
    if (result === 'off') return { entries: [], more: false, note: 'searchSymbolsOff' };
    if (!result) return { entries: [], more: false };
    // All keeps to the project, the engine and plugins; the system's are in Symbols, last.
    const shown = this.tab === 'all' ? result.filter((hit) => hit.place !== 'system') : result;
    return {
      entries: shown.slice(0, limit).map((hit) => {
        const kind = span(`search-symbol-icon ${symbolColors[hit.kind] ?? ''}`);
        kind.append(icon(symbolIcons[hit.kind] ?? 'symbol-misc'));
        const signature = span('search-signature');
        void this.hooks.signature(hit).then((declared) => { signature.textContent = declared; });
        const place = span('search-detail', [hit.container, `${baseName(hit.path)}:${hit.line + 1}`].filter(Boolean).join(' · '));
        place.title = hit.path;
        return this.entry(
          `symbol:${hit.path}:${hit.line}:${hit.name}`,
          () => this.hooks.openFile(hit.path, hit.line + 1, hit.character + 1),
          kind, span('search-name', hit.name), signature, place,
        );
      }),
      more: shown.length > limit || (this.tab === 'all' && shown.length < result.length),
    };
  }

  private commandEntries(limit: number): { entries: Entry[]; more: boolean } {
    const { text } = this.query();
    if (!text && this.tab !== 'commands') return { entries: [], more: false };
    const found = searchCommands(this.hooks.commands(), text).filter((command) => !command.disabled);
    return {
      entries: found.slice(0, limit).map((command) => {
        const parts: Node[] = [span('search-name', command.label), span('command-palette-category', command.category)];
        if (command.shortcut) parts.push(Object.assign(document.createElement('kbd'), { textContent: shortcutLabel(command.shortcut) }));
        return this.entry(`command:${command.category}:${command.label}`, () => command.run(), ...parts);
      }),
      more: found.length > limit,
    };
  }

  private mark(): void {
    this.entries.forEach((entry, index) => {
      entry.element.classList.toggle('selected', index === this.selected);
      if (entry.run) entry.element.setAttribute('aria-selected', String(index === this.selected));
    });
    this.entries[this.selected]?.element.scrollIntoView({ block: 'nearest' });
  }
}
