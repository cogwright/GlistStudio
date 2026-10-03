// Files and folders the explorer and search leave out, by name: builds, tools'
// own and packages', from Settings > General. * stands for any text, so
// cmake-build-* covers CLion's cmake-build-debug and cmake-build-release; case
// is ignored. Eclipse's .project, .cproject and .settings come with Glist apps,
// which the studio does not need, and clangd's .clangd with its settings.

export const defaultHiddenFolders = [
  '_build', 'cmake-build-*', 'build', 'out', '.git', '.idea', '.vscode', '.webpack', 'node_modules',
  '.settings', '.project', '.cproject', '.clangd',
];

// The patterns in a comma-separated list, as Settings takes it.
export const hiddenFolderList = (text: string): string[] => text.split(',').map((pattern) => pattern.trim()).filter(Boolean);

let patterns: RegExp[] = [];
export const setHiddenFolders = (names: string[]): void => {
  patterns = names.map((name) => new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
};
setHiddenFolders(defaultHiddenFolders);

export const isHiddenFolder = (name: string): boolean => patterns.some((pattern) => pattern.test(name));

// A path with a hidden file or folder in it, below the folder given.
export const isHiddenPath = (filePath: string, root: string): boolean => {
  const inside = filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
  return inside.split(/[\\/]/).filter(Boolean).some(isHiddenFolder);
};
