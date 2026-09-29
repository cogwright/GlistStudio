import { searchCommands } from './command-search';
import { t } from './localization';
import { shortcutLabel } from './shortcuts';

// The command palette: every command of the studio in one list to search, from
// anywhere in the window. The title bar's menus and the editor fill it.

export interface PaletteCommand {
  label: string;
  // Where it lives, such as the menu it is in.
  category: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export class CommandPalette {
  private readonly dialog = document.createElement('dialog');
  private readonly input = document.createElement('input');
  private readonly list = document.createElement('div');
  private commands: PaletteCommand[] = [];
  private shown: PaletteCommand[] = [];
  private selected = -1;

  constructor(private readonly source: () => PaletteCommand[]) {
    this.dialog.className = 'command-palette';
    this.input.type = 'text';
    this.input.className = 'command-palette-input';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-controls', 'command-palette-list');
    this.input.setAttribute('aria-expanded', 'true');
    this.list.id = 'command-palette-list';
    this.list.className = 'command-palette-list';
    this.list.setAttribute('role', 'listbox');
    this.dialog.append(this.input, this.list);
    document.body.append(this.dialog);
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (event) => this.onKey(event));
    // A click beside the list closes it, as Escape does.
    this.dialog.addEventListener('click', (event) => { if (event.target === this.dialog) this.dialog.close(); });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  toggle(): void {
    if (this.dialog.open) this.dialog.close();
    else this.open();
  }

  open(): void {
    this.commands = this.source();
    this.input.value = '';
    this.input.placeholder = t('paletteSearch');
    this.input.setAttribute('aria-label', t('commandPalette'));
    this.render();
    this.dialog.showModal();
    this.input.focus();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.run(this.shown[this.selected]);
    }
  }

  // Only commands that can run now take the selection.
  private move(step: number): void {
    const runnable = this.shown.flatMap((command, index) => (command.disabled ? [] : [index]));
    if (runnable.length === 0) return;
    const at = runnable.indexOf(this.selected);
    this.selected = at < 0 ? runnable[0] : runnable[(at + step + runnable.length) % runnable.length];
    this.mark();
  }

  private run(command: PaletteCommand | undefined): void {
    if (!command || command.disabled) return;
    // Closed first, so focus is back where it was when the command runs.
    this.dialog.close();
    command.run();
  }

  private render(): void {
    this.shown = searchCommands(this.commands, this.input.value);
    this.selected = this.shown.findIndex((command) => !command.disabled);
    if (this.shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'command-palette-empty';
      empty.textContent = t('paletteEmpty');
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...this.shown.map((command) => {
      const row = document.createElement('div');
      row.className = `command-palette-row${command.disabled ? ' disabled' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-disabled', String(Boolean(command.disabled)));
      const label = document.createElement('span');
      label.className = 'command-palette-label';
      label.textContent = command.label;
      const category = document.createElement('span');
      category.className = 'command-palette-category';
      category.textContent = command.category;
      row.append(label, category);
      if (command.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = shortcutLabel(command.shortcut);
        row.append(shortcut);
      }
      row.addEventListener('click', () => this.run(command));
      return row;
    }));
    this.mark();
  }

  private mark(): void {
    [...this.list.children].forEach((row, index) => {
      row.classList.toggle('selected', index === this.selected);
      row.setAttribute('aria-selected', String(index === this.selected));
    });
    this.list.children[this.selected]?.scrollIntoView({ block: 'nearest' });
  }
}
