// Files opened as SQLite databases rather than as text, by their extension; a
// .db that is not SQLite says so in its tab.
const extensions = new Set(['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3']);

export const isDatabaseFile = (filePath: string): boolean =>
  extensions.has(/\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase() ?? '');
