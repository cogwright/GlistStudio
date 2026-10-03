// How a project looked when it was last open, to open it the same way again:
// the tabs on each side of the editor and the one in front of each, the side
// that had the keys, the explorer's open folders, and where each file was
// scrolled to and its cursor. Kept in local storage by the project's folder.

export interface ProjectSession {
  groups: Array<{ tabs: string[]; active: string | null }>;
  focused: number;
  expanded: string[];
  // Monaco's view states, by file.
  views: Record<string, unknown>;
}

const storageKey = (root: string): string => `glist-studio-session:${root}`;

// Tabs of files and images come back; a diff or a README is opened again from where it came.
export const restorableTab = (key: string): boolean => !key.startsWith('diff:') && !key.startsWith('readme:');

export const loadSession = (root: string): ProjectSession | null => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(root)) ?? 'null') as Partial<ProjectSession> | null;
    if (!saved || !Array.isArray(saved.groups)) return null;
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
    return {
      groups: saved.groups.slice(0, 2).map((group) => {
        const tabs = strings(group?.tabs).filter(restorableTab);
        return { tabs, active: typeof group?.active === 'string' && tabs.includes(group.active) ? group.active : tabs[0] ?? null };
      }).filter((group) => group.tabs.length > 0),
      focused: Number.isInteger(saved.focused) ? saved.focused as number : 0,
      expanded: strings(saved.expanded),
      views: saved.views && typeof saved.views === 'object' ? saved.views : {},
    };
  } catch {
    return null;
  }
};

export const saveSession = (root: string, session: ProjectSession): void => {
  try { window.localStorage.setItem(storageKey(root), JSON.stringify(session)); } catch { /* Storage may be unavailable or full. */ }
};
