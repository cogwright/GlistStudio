import { promises as fs, watch, type Dirent, type FSWatcher } from 'node:fs';
import path from 'node:path';

// Tells when something changes in a folder or in the folders inside it, by its
// path relative to the folder, leaving out what `ignored` names.
//
// On Linux, Node's own recursive fs.watch watches every file by itself, reads a
// folder again in full each time something in it changes, and goes through
// every file it watches each time one is deleted, all on the event loop, where
// nothing else runs meanwhile. clangd started again rewrites its index in
// _build, some 1,940 files in a Glist project, each through a file renamed over
// it: the backend did nothing else for 12 seconds (measured in Electron's Node
// 24), and 2,000 files copied into assets held it for 5. So on Linux this
// watches each folder once, never goes into an ignored one, and looks for new
// folders without waiting on the disk. Elsewhere the system watches the whole
// tree itself, cheaply.
export interface TreeWatch {
  close(): void;
}

export const watchTree = (
  root: string,
  ignored: (relative: string) => boolean,
  changed: (relative: string) => void,
  byFolder = process.platform === 'linux',
): TreeWatch => {
  if (!byFolder) {
    const watcher = watch(root, { recursive: true }, (_event, file) => {
      const relative = file?.toString() ?? '';
      if (!ignored(relative)) changed(relative);
    });
    watcher.on('error', () => undefined);
    return { close: () => watcher.close() };
  }

  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  const relativeOf = (folder: string, name = ''): string => path.relative(root, path.join(folder, name));
  // A folder gone: its watch and those of the folders in it.
  const forget = (folder: string): void => {
    for (const [watched, watcher] of watchers) {
      if (watched !== folder && !watched.startsWith(folder + path.sep)) continue;
      watcher.close();
      watchers.delete(watched);
    }
  };
  const add = async (folder: string): Promise<void> => {
    if (closed || watchers.has(folder) || (folder !== root && ignored(relativeOf(folder)))) return;
    let watcher: FSWatcher;
    try {
      watcher = watch(folder, (event, name) => {
        const file = name?.toString();
        const relative = relativeOf(folder, file ?? '');
        if (ignored(relative)) return;
        changed(relative);
        // Something made, moved or deleted here: a folder among them is watched, or forgotten.
        if (event === 'rename' && file) void found(path.join(folder, file));
      });
    } catch {
      // Gone already, or the system has no watches left: the focus and save refreshes still work.
      return;
    }
    watcher.on('error', () => forget(folder));
    watchers.set(folder, watcher);
    let entries: Dirent[];
    try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    // Not links: a link to a folder above would go round for ever.
    for (const entry of entries) if (entry.isDirectory()) await add(path.join(folder, entry.name));
  };
  const found = async (target: string): Promise<void> => {
    const stats = await fs.lstat(target).catch((): null => null);
    if (stats?.isDirectory()) await add(target);
    else if (!stats && watchers.has(target)) forget(target);
  };
  void add(root);
  return {
    close: () => {
      closed = true;
      watchers.forEach((watcher) => watcher.close());
      watchers.clear();
    },
  };
};
