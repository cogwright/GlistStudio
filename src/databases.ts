// Files opened as SQLite databases rather than as text, by their extension; a
// .db that is not SQLite says so in its tab.
const extensions = new Set(['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3']);

export const isDatabaseFile = (filePath: string): boolean =>
  extensions.has(/\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase() ?? '');

// SQLite's own files beside a database: the journal of changes not committed
// yet, and the write-ahead log with its index. They are there while a database
// is open or changes wait in it (database.ts), never the project's to keep, so
// the explorer, search and the commit view leave them out.
const sideFile = new RegExp(`\\.(?:${[...extensions].join('|')})-(?:journal|wal|shm)$`, 'i');
export const isDatabaseSideFile = (filePath: string): boolean => sideFile.test(filePath);
