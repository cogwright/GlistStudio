import { t } from './localization';

// Settings > Run and Debug: the arguments the open project's program is given,
// written as on a command line and kept per project.

// Split at spaces; quotes keep spaces in. A backslash only escapes a quote, so
// Windows paths such as C:\data\level.txt stay as they are written.
export const splitArguments = (line: string): string[] => {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | '\'' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === '\\' && quote !== '\'' && (next === '"' || (next === '\'' && !quote))) {
      current += next;
      started = true;
      index += 1;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === '"' || character === '\'') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += character;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
};

const key = (root: string): string => `glist-studio-run-arguments:${root}`;

export class RunArguments {
  private root: string | null = null;
  private name = '';

  constructor(private readonly input: HTMLInputElement, private readonly hint: HTMLElement) {
    input.addEventListener('change', () => {
      if (!this.root) return;
      try { window.localStorage.setItem(key(this.root), input.value); } catch { /* Storage may be unavailable. */ }
      void window.glistAPI.setRunArguments(splitArguments(input.value));
    });
  }

  projectChanged(root: string | null, name: string): void {
    this.root = root;
    this.name = name;
    let saved = '';
    try { saved = root ? window.localStorage.getItem(key(root)) ?? '' : ''; } catch { /* Storage may be unavailable. */ }
    this.input.value = saved;
    void window.glistAPI.setRunArguments(splitArguments(saved));
    this.describe();
  }

  // Also when the language changes.
  describe(): void {
    this.input.disabled = !this.root;
    this.hint.textContent = this.root ? t('runArgumentsHint').replace('{project}', this.name) : t('runArgumentsNoProject');
  }
}
