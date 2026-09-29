// Which tabs each side of the editor area has, in order, and which one is in
// front, as VS Code's editor groups: the same file can have a tab on both
// sides, and stays open while any tab shows it. No DOM and no Monaco here, so
// it can be tested on its own; the renderer draws what it describes.

export interface EditorGroupState {
  tabs: string[];
  active: string | null;
}

// Side by side at most, left and right.
export const maxGroups = 2;

export class EditorLayout {
  groups: EditorGroupState[] = [{ tabs: [], active: null }];
  // The group the keyboard and commands act on.
  focused = 0;

  get focusedGroup(): EditorGroupState {
    return this.groups[this.focused];
  }

  // The tab in front of the focused group.
  get activeKey(): string | null {
    return this.focusedGroup.active;
  }

  isOpen(key: string): boolean {
    return this.groups.some((group) => group.tabs.includes(key));
  }

  groupsWith(key: string): number[] {
    return this.groups.flatMap((group, index) => (group.tabs.includes(key) ? [index] : []));
  }

  // Every tab's key, each once, in group order.
  keys(): string[] {
    return [...new Set(this.groups.flatMap((group) => group.tabs))];
  }

  focus(group: number): void {
    if (this.groups[group]) this.focused = group;
  }

  // Gives a group a tab, at the end, without bringing it to the front.
  add(key: string, group = this.focused): void {
    const target = this.groups[group];
    if (target && !target.tabs.includes(key)) target.tabs.push(key);
  }

  // Brings a tab to the front of a group, adding it there first if need be, and focuses the group.
  activate(key: string, group = this.focused): void {
    this.add(key, group);
    if (!this.groups[group]) return;
    this.groups[group].active = key;
    this.focused = group;
  }

  // Takes a tab out of a group. The tab that took its place comes to the
  // front, and a group left empty beside another goes. Whether any tab still
  // shows the key is for the caller to ask, with isOpen.
  close(key: string, group = this.focused): void {
    const target = this.groups[group];
    const index = target?.tabs.indexOf(key) ?? -1;
    if (!target || index < 0) return;
    target.tabs.splice(index, 1);
    if (target.active === key) target.active = target.tabs[Math.min(index, target.tabs.length - 1)] ?? null;
    this.dropEmpty();
  }

  // Moves a tab within its group or to another one, before a tab there or at
  // its end. A group one past the last is a new one to the right.
  move(key: string, from: number, to: number, before?: string): void {
    const source = this.groups[from];
    if (!source?.tabs.includes(key) || to > this.groups.length || to >= maxGroups) return;
    if (to === this.groups.length) this.groups.push({ tabs: [], active: null });
    const target = this.groups[to];
    if (from !== to && target.tabs.includes(key)) {
      // Already there: that tab takes the moved one's place.
      target.tabs.splice(target.tabs.indexOf(key), 1);
    }
    const sourceIndex = source.tabs.indexOf(key);
    source.tabs.splice(sourceIndex, 1);
    if (from !== to && source.active === key) source.active = source.tabs[Math.min(sourceIndex, source.tabs.length - 1)] ?? null;
    const at = before && before !== key ? target.tabs.indexOf(before) : -1;
    target.tabs.splice(at < 0 ? target.tabs.length : at, 0, key);
    // Moved to another group, it comes to the front there; reordered, nothing else changes.
    if (from !== to) {
      target.active = key;
      this.focused = to;
    }
    this.dropEmpty();
  }

  // Opens a tab of the same file in the group beside, as Split Right does,
  // making that group if there is only one.
  split(key: string, from = this.focused): void {
    if (!this.groups[from]?.tabs.includes(key)) return;
    const to = from + 1 < maxGroups ? from + 1 : from - 1;
    if (to === this.groups.length) this.groups.push({ tabs: [], active: null });
    this.activate(key, to);
  }

  // A file that moved on disk keeps its tabs' places.
  rename(from: string, to: string): void {
    this.groups.forEach((group) => {
      group.tabs = group.tabs.map((key) => (key === from ? to : key));
      if (group.active === from) group.active = to;
    });
  }

  // Closes every tab whose key matches, such as the files in a deleted folder.
  // A group whose tab in front went shows its last tab instead.
  remove(matches: (key: string) => boolean): void {
    this.groups.forEach((group) => {
      group.tabs = group.tabs.filter((key) => !matches(key));
      if (group.active !== null && matches(group.active)) group.active = group.tabs.at(-1) ?? null;
    });
    this.dropEmpty();
  }

  clear(): void {
    this.groups = [{ tabs: [], active: null }];
    this.focused = 0;
  }

  private dropEmpty(): void {
    if (this.groups.length < 2) return;
    const focusedGroup = this.groups[this.focused];
    this.groups = this.groups.filter((group) => group.tabs.length > 0);
    if (this.groups.length === 0) this.groups = [{ tabs: [], active: null }];
    const kept = this.groups.indexOf(focusedGroup);
    this.focused = kept >= 0 ? kept : Math.min(this.focused, this.groups.length - 1);
  }
}
