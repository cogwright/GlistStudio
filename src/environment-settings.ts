import { icon } from './icons';
import { t } from './localization';

// Settings > Environment: variables set for builds, runs, the debugger and the
// terminal, in every project. PATH has a list of its own above them.

const storageKey = 'glist-studio-environment';

const saved = (): GlistVariable[] => {
  try {
    const variables = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]') as unknown;
    return Array.isArray(variables) ? variables.filter((variable): variable is GlistVariable =>
      typeof variable?.name === 'string' && typeof variable?.value === 'string') : [];
  } catch {
    return [];
  }
};

export class EnvironmentSettings {
  // What is on screen, including rows still being written or refused.
  private rows: GlistVariable[] = saved();

  constructor(private readonly list: HTMLElement, add: HTMLButtonElement, private readonly error: HTMLElement) {
    void this.save();
    this.render();
    add.addEventListener('click', () => {
      this.rows.push({ name: '', value: '' });
      this.render();
      this.list.querySelector<HTMLInputElement>('.env-row:last-child .env-name')?.focus();
    });
  }

  private render(): void {
    this.list.replaceChildren(...this.rows.map((variable, index) => {
      const row = document.createElement('div');
      row.className = 'env-row';
      const field = (className: string, placeholder: string, value: string, set: (text: string) => void): HTMLInputElement => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = className;
        input.placeholder = placeholder;
        input.value = value;
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.addEventListener('change', () => { set(input.value); void this.save(); });
        return input;
      };
      const name = field('env-name', t('envName'), variable.name, (text) => { this.rows[index].name = text; });
      const value = field('env-value', t('envValue'), variable.value, (text) => { this.rows[index].value = text; });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'path-remove';
      remove.title = t('removePathFolder');
      remove.setAttribute('aria-label', t('removePathFolder'));
      remove.append(icon('close'));
      remove.addEventListener('click', () => { this.rows.splice(index, 1); this.render(); void this.save(); });
      row.append(name, value, remove);
      return row;
    }));
  }

  // Only what the backend kept is saved; a named row it refused stays, marked, to be fixed.
  private async save(): Promise<void> {
    const named = this.rows.filter((variable) => variable.name.trim());
    const kept = await window.glistAPI.setCustomEnvironment(named).catch((): GlistVariable[] => []);
    try { window.localStorage.setItem(storageKey, JSON.stringify(kept)); } catch { /* Storage may be unavailable. */ }
    const refused = named.filter((variable) => !kept.some((entry) => entry.name === variable.name.trim()));
    this.error.textContent = refused.length > 0 ? t('envInvalid') : '';
    this.list.querySelectorAll<HTMLElement>('.env-row').forEach((row, index) => {
      row.classList.toggle('refused', refused.includes(this.rows[index]));
    });
  }
}
