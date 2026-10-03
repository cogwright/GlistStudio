// Folders the explorer and search leave out, by name: builds, tools' own and
// packages', from Settings > General. * stands for any text, so cmake-build-*
// covers CLion's cmake-build-debug and cmake-build-release; case is ignored.

export const defaultHiddenFolders = ['_build', 'cmake-build-*', 'build', 'out', '.git', '.idea', '.vscode', '.webpack', 'node_modules'];

// The patterns in a comma-separated list, as Settings takes it.
export const hiddenFolderList = (text: string): string[] => text.split(',').map((pattern) => pattern.trim()).filter(Boolean);

let patterns: RegExp[] = [];
export const setHiddenFolders = (names: string[]): void => {
  patterns = names.map((name) => new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
};
setHiddenFolders(defaultHiddenFolders);

export const isHiddenFolder = (name: string): boolean => patterns.some((pattern) => pattern.test(name));
