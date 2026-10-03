import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { isHiddenFolder } from './hidden-folders';
import { findInText, queryPattern, type TextQuery } from './text-search';

// Find in Files and Search Everywhere's files: every file in the project, and
// in the engine and plugins when asked, without what Git, builds and packages
// keep there. No Electron, so it can be tested on its own.

export interface SearchFolder {
  path: string;
  name: string;
  kind: 'project' | 'engine' | 'plugin';
}

export interface FoundFile {
  path: string;
  // From its folder, with / between names.
  relative: string;
  owner: string;
  kind: SearchFolder['kind'];
}

export interface FileMatches extends FoundFile {
  matches: ReturnType<typeof findInText>;
}

export interface SearchOutcome {
  files: FileMatches[];
  matches: number;
  // More matches were there than are given.
  limited: boolean;
}

// Larger files are data rather than code.
const largestFile = 2 * 1024 * 1024;

const byName = (left: Dirent, right: Dirent): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

// The files under the folders, in name order, folder by folder, up to a limit.
export const filesIn = async (folders: SearchFolder[], limit = 50000, cancelled = (): boolean => false): Promise<FoundFile[]> => {
  const found: FoundFile[] = [];
  for (const folder of folders) {
    const walk = async (directory: string, relative: string): Promise<void> => {
      if (found.length >= limit || cancelled()) return;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch((): Dirent[] => []);
      entries.sort(byName);
      for (const entry of entries) {
        if (found.length >= limit) return;
        const inner = relative ? `${relative}/${entry.name}` : entry.name;
        // Links are left out, so a link to a folder above cannot make it go round.
        if (entry.isDirectory()) {
          // Hidden ones too, and the explorer's hidden folders (hidden-folders.ts).
          if (!entry.name.startsWith('.') && !isHiddenFolder(entry.name)) await walk(path.join(directory, entry.name), inner);
        } else if (entry.isFile() && !isHiddenFolder(entry.name)) {
          found.push({ path: path.join(directory, entry.name), relative: inner, owner: folder.name, kind: folder.kind });
        }
      }
    };
    await walk(folder.path, '');
  }
  return found;
};

// Text only: a file with a zero byte near its start is taken as binary.
const readText = async (filePath: string): Promise<string | null> => {
  const stats = await fs.stat(filePath).catch((): null => null);
  if (!stats || stats.size > largestFile) return null;
  const buffer = await fs.readFile(filePath).catch((): null => null);
  if (!buffer || buffer.subarray(0, 8000).includes(0)) return null;
  return buffer.toString('utf8');
};

// Every match of the query in the folders' files, up to a limit. A newer search
// can cancel this one, which then stops where it is.
export const searchFolders = async (
  folders: SearchFolder[], query: TextQuery, limit = 2000, cancelled = (): boolean => false,
): Promise<SearchOutcome> => {
  const pattern = queryPattern(query);
  const outcome: SearchOutcome = { files: [], matches: 0, limited: false };
  if (!pattern) return outcome;
  const files = await filesIn(folders, 50000, cancelled);
  // A few files read at once, kept in order.
  const batch = 24;
  for (let start = 0; start < files.length; start += batch) {
    if (cancelled()) return outcome;
    const texts = await Promise.all(files.slice(start, start + batch).map((file) => readText(file.path)));
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      if (text === null) continue;
      const matches = findInText(text, pattern, limit - outcome.matches + 1);
      if (matches.length === 0) continue;
      if (outcome.matches + matches.length > limit) {
        outcome.limited = true;
        matches.length = limit - outcome.matches;
      }
      if (matches.length > 0) outcome.files.push({ ...files[start + index], matches });
      outcome.matches += matches.length;
      if (outcome.limited) return outcome;
    }
  }
  return outcome;
};
