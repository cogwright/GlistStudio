export type CmakeChange =
  | { kind: 'add'; paths: string[] }
  | { kind: 'remove'; path: string }
  | { kind: 'rename'; from: string; to: string };

type ListName = 'SOURCES' | 'HEADERS';

const listPattern = /(set\s*\(\s*GlistApp_(SOURCES|HEADERS)\b)([\s\S]*?)(\))/gi;
const entryPattern = /^(\s*)(?:"(\$\{APP_DIR\}\/[^"]+)"|(\$\{APP_DIR\}\/[^\s)#]+))([ \t]*(?:#.*)?)$/;

const normalize = (filePath: string): string => filePath.replace(/\\/g, '/').replace(/^\/+/, '');

const listFor = (filePath: string): ListName | null => {
  const extension = filePath.split('.').pop()?.toLowerCase();
  if (extension && ['c', 'cc', 'cpp', 'cxx'].includes(extension)) return 'SOURCES';
  if (extension && ['h', 'hh', 'hpp', 'hxx'].includes(extension)) return 'HEADERS';
  return null;
};

const entryPath = (line: string): string | null => {
  const match = line.match(entryPattern);
  return match ? normalize((match[2] ?? match[3]).slice('${APP_DIR}/'.length)) : null;
};

const matchingPath = (candidate: string, target: string): boolean => {
  const lowerCandidate = candidate.toLowerCase();
  const lowerTarget = target.toLowerCase();
  return lowerCandidate === lowerTarget || lowerCandidate.startsWith(`${lowerTarget}/`);
};

const formatEntry = (relativePath: string): string => {
  const value = `\${APP_DIR}/${relativePath}`;
  return /\s/.test(value) ? `"${value}"` : value;
};

export const hasGlistSourceLists = (cmake: string): boolean => {
  const lists = [...cmake.matchAll(listPattern)].map((match) => match[2].toUpperCase());
  return lists.includes('SOURCES') && lists.includes('HEADERS');
};

export const synchronizeCmake = (cmake: string, change: CmakeChange): string => {
  if (!hasGlistSourceLists(cmake)) return cmake;
  const newline = cmake.includes('\r\n') ? '\r\n' : '\n';
  const additions: string[] = change.kind === 'add' ? change.paths.map(normalize) : [];

  let updated = cmake.replace(listPattern, (whole, start: string, list: string, body: string, end: string) => {
    const listName = list.toUpperCase() as ListName;
    const lines = body.split(/\r?\n/);
    const nextLines: string[] = [];
    lines.forEach((line) => {
      const relative = entryPath(line);
      if (!relative || change.kind === 'add') { nextLines.push(line); return; }
      if (change.kind === 'remove' && matchingPath(relative, normalize(change.path))) return;
      if (change.kind === 'rename' && matchingPath(relative, normalize(change.from))) {
        const oldRelative = normalize(change.from);
        const nextRelative = `${normalize(change.to)}${relative.slice(oldRelative.length)}`;
        if (listFor(nextRelative) !== listName) {
          additions.push(nextRelative);
          return;
        }
        const match = line.match(entryPattern);
        if (match) nextLines.push(`${match[1]}${formatEntry(nextRelative)}${match[4]}`);
        return;
      }
      nextLines.push(line);
    });
    return `${start}${nextLines.join(newline)}${end}`;
  });

  if (additions.length === 0) return updated;
  const existing = new Set<string>();
  [...updated.matchAll(listPattern)].forEach((block) => {
    block[3].split(/\r?\n/).forEach((line) => {
      const relative = entryPath(line);
      if (relative) existing.add(relative.toLowerCase());
    });
  });
  updated = updated.replace(listPattern, (whole, start: string, list: string, body: string, end: string) => {
    const listName = list.toUpperCase() as ListName;
    const pending = additions.filter((relative) => listFor(relative) === listName && !existing.has(relative.toLowerCase()));
    pending.forEach((relative) => existing.add(relative.toLowerCase()));
    if (pending.length === 0) return whole;
    const indent = body.split(/\r?\n/).map((line) => line.match(entryPattern)?.[1]).find((value) => value !== undefined) ?? '\t\t';
    const separator = body.endsWith(newline) ? '' : newline;
    return `${start}${body}${separator}${pending.map((relative) => `${indent}${formatEntry(relative)}`).join(newline)}${newline}${end}`;
  });
  return updated;
};
