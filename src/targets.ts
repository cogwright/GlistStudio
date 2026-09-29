import { t } from './localization';

// Settings > Build > Show all targets: a list beside Run of every target the
// project's CMake builds, as CLion has, to build, run or debug any of them.
// Off, Build builds everything and Run starts the app, as before.

const shownKey = 'glist-studio-show-targets';
const chosenKey = (root: string): string => `glist-studio-target:${root}`;

const read = (key: string): string | null => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};

const write = (key: string, value: string): void => {
  try { window.localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
};

export class TargetPicker {
  private targets: GlistTarget[] = [];
  private root: string | null = null;

  // changed: Run and Debug may have become possible or not.
  constructor(private readonly select: HTMLSelectElement, private readonly changed: () => void) {
    select.addEventListener('change', () => {
      if (this.root) write(chosenKey(this.root), select.value);
      void window.glistAPI.setTarget(select.value || null);
      this.changed();
    });
  }

  get shown(): boolean {
    return read(shownKey) === 'on';
  }

  set shown(on: boolean) {
    write(shownKey, on ? 'on' : 'off');
    void this.refresh();
  }

  // Whether Run and Debug have a program to start: libraries and build steps have none.
  get runnable(): boolean {
    if (!this.shown) return true;
    const target = this.targets.find((entry) => entry.name === this.select.value);
    return !target || target.type === 'executable';
  }

  projectChanged(root: string | null): void {
    this.root = root;
    this.targets = [];
    void this.refresh();
  }

  // Asked again after builds and configures, which is when targets change.
  async refresh(): Promise<void> {
    const root = this.root;
    if (!this.shown || !root) {
      this.select.hidden = true;
      this.targets = [];
      await window.glistAPI.setTarget(null);
      this.changed();
      return;
    }
    const targets = await window.glistAPI.listTargets().catch((): GlistTarget[] => []);
    if (root !== this.root || !this.shown) return;
    this.targets = targets;
    this.render(root);
    this.select.hidden = false;
    await window.glistAPI.setTarget(this.select.value || null);
    this.changed();
  }

  private render(root: string): void {
    const groups = new Map<string, HTMLOptGroupElement>();
    const projectName = root.split(/[\\/]/).filter(Boolean).pop() ?? '';
    const label = (target: GlistTarget): string => (target.group === 'project' ? projectName
      : target.group === 'engine' ? 'GlistEngine' : target.group === 'plugin' ? target.owner : t('otherTargets'));
    this.targets.forEach((target) => {
      const heading = label(target);
      let group = groups.get(heading);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = heading;
        groups.set(heading, group);
      }
      const option = document.createElement('option');
      option.value = target.name;
      option.textContent = target.type === 'executable' ? target.name
        : `${target.name} (${t(target.type === 'library' ? 'targetLibrary' : 'targetStep')})`;
      group.append(option);
    });
    if (this.targets.length === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('noTargets');
      this.select.replaceChildren(empty);
      return;
    }
    this.select.replaceChildren(...groups.values());
    const saved = read(chosenKey(root));
    const fallback = this.targets.find((target) => target.app) ?? this.targets.find((target) => target.type === 'executable') ?? this.targets[0];
    this.select.value = this.targets.some((target) => target.name === saved) ? saved ?? '' : fallback.name;
  }
}
