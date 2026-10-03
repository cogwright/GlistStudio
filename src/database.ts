import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { quoteName } from './database-sql';

// SQLite databases for their tabs (database-page.ts), read, changed and queried
// with SQLite itself, through Node's node:sqlite: no build of its own, and the
// same in the app and the browser build. Each database is opened when first
// asked for, so a backend started again simply opens it again, and closed with
// its tab. Values cross to the window as JSON does: big integers as text, and
// a BLOB as its size.

const pageRows = 100;
const queryRows = 1000;
// The rowid, under a name no column has, beside a table's own columns.
const keyColumn = 'glist·rowid';

export const cellOf = (value: unknown): GlistDatabaseCell => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof Uint8Array) return { blob: value.byteLength };
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
};

// Whitespace, comments and stray semicolons before the next statement.
export const statementStart = (sql: string): string => {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^[\s;]+/, '');
    if (trimmed.startsWith('--')) rest = trimmed.includes('\n') ? trimmed.slice(trimmed.indexOf('\n') + 1) : '';
    else if (trimmed.startsWith('/*')) rest = trimmed.includes('*/') ? trimmed.slice(trimmed.indexOf('*/') + 2) : '';
    else return trimmed;
  }
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface Opened { database: DatabaseSync; readOnly: boolean }

export class Databases {
  private readonly opened = new Map<string, Opened>();
  private sqlite: typeof import('node:sqlite') | null = null;

  constructor(
    // Where a file may be opened from, and whether only to read it; throws otherwise.
    private readonly locate: (filePath: string) => Promise<{ file: string; readOnly: boolean }>,
    private readonly unavailable: () => string,
  ) {}

  private async open(filePath: string): Promise<Opened> {
    const known = this.opened.get(filePath);
    if (known) return known;
    const { file, readOnly } = await this.locate(filePath);
    if (!this.sqlite) {
      try { this.sqlite = await import('node:sqlite'); } catch { throw new Error(this.unavailable()); }
    }
    // A Glist app running beside the studio may hold the file a moment.
    const database = new this.sqlite.DatabaseSync(file, { readOnly, timeout: 3000 });
    const opened = { database, readOnly };
    this.opened.set(filePath, opened);
    return opened;
  }

  close(filePath: string): void {
    const known = this.opened.get(filePath);
    this.opened.delete(filePath);
    try { known?.database.close(); } catch { /* Already closed. */ }
  }

  closeAll(): void {
    [...this.opened.keys()].forEach((filePath) => this.close(filePath));
  }

  // One table or view as the schema lists it; its rows counted only when asked.
  private describe(database: DatabaseSync, row: Record<string, unknown>, counted: boolean): GlistDatabaseTable {
    const all = (sql: string, ...values: Array<string | number>): Array<Record<string, unknown>> =>
      database.prepare(sql).all(...values) as Array<Record<string, unknown>>;
    const name = String(row.name);
    const kind = row.type === 'view' ? 'view' : 'table';
    let rows: number | null = null;
    if (counted && kind === 'table') {
      try { rows = Number(database.prepare(`SELECT count(*) AS n FROM ${quoteName(name)}`).get()?.n); } catch { rows = null; }
    }
    return {
      name,
      kind,
      withoutRowid: Number(row.wr) === 1,
      sql: String(row.sql ?? ''),
      rows,
      columns: all('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_xinfo(?) WHERE hidden IN (0, 2, 3)', name).map((column) => ({
        name: String(column.name),
        type: String(column.type ?? ''),
        notNull: Number(column.notnull) === 1,
        primaryKey: Number(column.pk),
        defaultValue: column.dflt_value === null ? null : String(column.dflt_value),
      })),
      indexes: kind === 'view' ? [] : all('SELECT name, "unique", origin FROM pragma_index_list(?)', name).map((index) => ({
        name: String(index.name),
        unique: Number(index.unique) === 1,
        automatic: index.origin !== 'c',
        columns: all('SELECT name FROM pragma_index_info(?) ORDER BY seqno', String(index.name)).map((column) => String(column.name ?? '(expression)')),
      })),
      foreignKeys: kind === 'view' ? [] : all('SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)', name).map((key) => ({
        from: String(key.from), table: String(key.table), to: key.to === null ? '' : String(key.to),
      })),
    };
  }

  private listed(database: DatabaseSync, name?: string): Array<Record<string, unknown>> {
    const statement = database.prepare(`SELECT l.name, l.type, l.wr, s.sql FROM pragma_table_list AS l
      LEFT JOIN sqlite_schema AS s ON s.name = l.name
      WHERE l.schema = 'main' AND l.type IN ('table', 'view') AND l.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'${name === undefined ? '' : ' AND l.name = ?'}
      ORDER BY l.type, l.name COLLATE NOCASE`);
    return (name === undefined ? statement.all() : statement.all(name)) as Array<Record<string, unknown>>;
  }

  private table(database: DatabaseSync, name: string): GlistDatabaseTable {
    const [row] = this.listed(database, name);
    if (!row) throw new Error(`no such table: ${name}`);
    return this.describe(database, row, false);
  }

  async schema(filePath: string): Promise<GlistDatabaseSchema> {
    const { database, readOnly } = await this.open(filePath);
    const tables = this.listed(database).map((row) => this.describe(database, row, true));
    const triggers = (database.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all() as Array<Record<string, unknown>>)
      .map((row) => ({ name: String(row.name), table: String(row.tbl_name), sql: String(row.sql ?? '') }));
    const version = String(database.prepare('SELECT sqlite_version() AS v').get()?.v ?? '');
    return { tables, triggers, readOnly, version };
  }

  // A table's or view's rows, a page at a time, with what tells each row apart
  // for changing it: the rowid, or a WITHOUT ROWID table's primary key.
  async rows(filePath: string, table: string, options: GlistDatabaseRowsOptions): Promise<GlistDatabaseRows> {
    const { database } = await this.open(filePath);
    const schema = this.table(database, table);
    const columns = schema.columns.map((column) => column.name);
    const keyed = schema.kind === 'table';
    const byRowid = keyed && !schema.withoutRowid;
    // The filter is SQL as typed; its own line, so a -- comment in it cannot end the LIMIT after it.
    const where = options.where?.trim() ? ` WHERE (${options.where}\n)` : '';
    const order = options.orderBy && columns.includes(options.orderBy) ? ` ORDER BY ${quoteName(options.orderBy)} ${options.descending ? 'DESC' : 'ASC'}` : '';
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const select = `SELECT ${byRowid ? `rowid AS ${quoteName(keyColumn)}, ` : ''}${columns.map(quoteName).join(', ')} FROM ${quoteName(table)}`;
    const statement = database.prepare(`${select}${where}${order} LIMIT ${pageRows} OFFSET ${offset}`);
    statement.setReturnArrays(true);
    statement.setReadBigInts(true);
    const found = (statement.all() as unknown as unknown[][]).map((row) => row.map(cellOf));
    const total = Number(database.prepare(`SELECT count(*) AS n FROM ${quoteName(table)}${where}`).get()?.n ?? 0);
    const primary = schema.columns.filter((column) => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey).map((column) => column.name);
    return {
      columns,
      rows: byRowid ? found.map((row) => row.slice(1)) : found,
      keys: !keyed ? null : byRowid ? found.map((row) => [row[0]]) : found.map((row) => primary.map((name) => row[columns.indexOf(name)])),
      keyColumns: !keyed ? [] : byRowid ? ['rowid'] : primary,
      total,
      offset,
      pageSize: pageRows,
    };
  }

  // Runs what was typed, statement by statement as SQLite itself reads them,
  // each before the next is read (so one can use a table the last made),
  // stopping at the first that fails.
  async query(filePath: string, sql: string): Promise<GlistDatabaseResult[]> {
    const { database } = await this.open(filePath);
    const results: GlistDatabaseResult[] = [];
    let rest = statementStart(sql);
    while (rest) {
      const started = Date.now();
      let statement: StatementSync;
      try { statement = database.prepare(rest); } catch (error) {
        results.push({ sql: rest.split(/;\s*(?:\n|$)/)[0].slice(0, 400), error: message(error) });
        break;
      }
      const text = statement.sourceSQL;
      rest = rest.startsWith(text) && text ? statementStart(rest.slice(text.length)) : '';
      try {
        const columns = statement.columns().map((column) => column.name);
        if (columns.length) {
          statement.setReturnArrays(true);
          statement.setReadBigInts(true);
          const rows: GlistDatabaseCell[][] = [];
          let truncated = false;
          for (const row of statement.iterate() as unknown as Iterable<unknown[]>) {
            if (rows.length >= queryRows) { truncated = true; break; }
            rows.push(row.map(cellOf));
          }
          results.push({ sql: text.trim(), columns, rows, truncated, milliseconds: Date.now() - started });
        } else {
          const outcome = statement.run();
          results.push({
            sql: text.trim(), changes: Number(outcome.changes), lastInsertRowid: cellOf(outcome.lastInsertRowid), milliseconds: Date.now() - started,
          });
        }
      } catch (error) {
        results.push({ sql: text.trim(), error: message(error) });
        break;
      }
    }
    return results;
  }

  // A row changed, added or deleted from the grid. Values go in as typed, and
  // the column's type decides what SQLite keeps (its type affinity), as it
  // would for the same SQL; NULL is said as null, never as an empty text.
  async edit(filePath: string, edit: GlistDatabaseEdit): Promise<{ changes: number }> {
    const { database } = await this.open(filePath);
    const schema = this.table(database, edit.table);
    if (schema.kind !== 'table') throw new Error(`cannot modify ${edit.table} because it is a view`);
    const names = schema.columns.map((column) => column.name);
    const primary = schema.columns.filter((column) => column.primaryKey > 0).sort((a, b) => a.primaryKey - b.primaryKey).map((column) => column.name);
    const keyMatch = schema.withoutRowid ? primary.map((name) => `${quoteName(name)} IS ?`).join(' AND ') : 'rowid = ?';
    const keyValues = (key: GlistDatabaseCell[]): Array<string | number | null> =>
      key.map((value) => (typeof value === 'number' || typeof value === 'string' ? value : null));
    const run = (sql: string, ...values: Array<string | number | null>): number => Number(database.prepare(sql).run(...values).changes);
    if (edit.kind === 'update') {
      if (!names.includes(edit.column)) throw new Error(`no such column: ${edit.column}`);
      return { changes: run(`UPDATE ${quoteName(edit.table)} SET ${quoteName(edit.column)} = ? WHERE ${keyMatch}`, edit.value, ...keyValues(edit.key)) };
    }
    if (edit.kind === 'insert') {
      const given = Object.keys(edit.values).filter((name) => names.includes(name));
      if (!given.length) return { changes: run(`INSERT INTO ${quoteName(edit.table)} DEFAULT VALUES`) };
      return {
        changes: run(`INSERT INTO ${quoteName(edit.table)} (${given.map(quoteName).join(', ')}) VALUES (${given.map(() => '?').join(', ')})`,
          ...given.map((name) => edit.values[name])),
      };
    }
    let changes = 0;
    database.exec('SAVEPOINT glist_delete');
    try {
      edit.keys.forEach((key) => { changes += run(`DELETE FROM ${quoteName(edit.table)} WHERE ${keyMatch}`, ...keyValues(key)); });
      database.exec('RELEASE glist_delete');
    } catch (error) {
      database.exec('ROLLBACK TO glist_delete');
      database.exec('RELEASE glist_delete');
      throw error;
    }
    return { changes };
  }
}
