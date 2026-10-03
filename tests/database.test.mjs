/* global BigInt */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Databases, cellOf, statementStart } from '../src/database.ts';
import { createTableSql, quoteName } from '../src/database-sql.ts';

// What crosses to the window: big integers as text, BLOBs as their size.
assert.equal(cellOf(BigInt(42)), 42);
assert.equal(cellOf(BigInt('9007199254740993')), '9007199254740993');
assert.deepEqual(cellOf(new Uint8Array([1, 2, 3])), { blob: 3 });
assert.equal(cellOf(undefined), null);
assert.equal(statementStart('  -- note\n /* block */ ;; select 1'), 'select 1');
assert.equal(statementStart('-- only a comment'), '');

// The New Table form's SQL: names quoted, one INTEGER key left as the rowid,
// several made one key together, defaults as text unless numbers or keywords.
const column = (name, type, more = {}) => ({ name, type, primaryKey: false, notNull: false, unique: false, defaultValue: '', ...more });
assert.equal(quoteName('say "hi"'), '"say ""hi"""');
assert.equal(createTableSql('items', [
  column('id', 'INTEGER', { primaryKey: true }),
  column('label', 'TEXT', { notNull: true, unique: true, defaultValue: "it's" }),
  column('made', 'TEXT', { defaultValue: 'current_timestamp' }),
  column('', 'TEXT'),
]), `CREATE TABLE "items" (\n  "id" INTEGER PRIMARY KEY,\n  "label" TEXT NOT NULL UNIQUE DEFAULT 'it''s',\n  "made" TEXT DEFAULT current_timestamp\n);`);
assert.equal(createTableSql('pairs', [column('a', 'INTEGER', { primaryKey: true }), column('b', 'TEXT', { primaryKey: true, defaultValue: '-1.5' })]),
  `CREATE TABLE "pairs" (\n  "a" INTEGER,\n  "b" TEXT DEFAULT -1.5,\n  PRIMARY KEY ("a", "b")\n);`);

const root = mkdtempSync(path.join(tmpdir(), 'glist-database-'));
const file = path.join(root, 'game.db');
const elsewhere = path.join(root, 'engine.db');
const notSqlite = path.join(root, 'notes.db');
writeFileSync(notSqlite, 'just some text');
const databases = new Databases(async (filePath) => {
  if (filePath === notSqlite) throw new Error('not a database');
  return { file: filePath, readOnly: filePath === elsewhere };
}, () => 'unavailable');

try {
  // The console: statements run in order, each before the next is read, a
  // trigger's body kept whole, results and changes per statement.
  const made = await databases.query(file, `
    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL DEFAULT 0, avatar BLOB, big INTEGER);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    CREATE VIEW leaders AS SELECT name, score FROM players ORDER BY score DESC;
    CREATE TABLE log (what TEXT);
    CREATE TRIGGER logged AFTER INSERT ON players BEGIN INSERT INTO log VALUES ('added ' || new.name); SELECT 1; END;
    -- a comment between
    INSERT INTO players (name, score, avatar, big) VALUES ('ada', 12.5, x'00ff', 9007199254740993), ('linus', 7, NULL, 1);
    INSERT INTO settings VALUES ('volume', '7');
    SELECT name, score, avatar, big FROM players ORDER BY id`);
  assert.equal(made.length, 8, JSON.stringify(made));
  assert.ok(made.every((result) => !('error' in result)), JSON.stringify(made));
  assert.equal(made[5].changes, 2);
  assert.deepEqual(made[7].columns, ['name', 'score', 'avatar', 'big']);
  assert.deepEqual(made[7].rows, [['ada', 12.5, { blob: 2 }, '9007199254740993'], ['linus', 7, null, 1]]);
  assert.match(made[4].sql, /BEGIN INSERT INTO log .* END;$/);

  // It stops at the first statement that fails, saying which.
  const failed = await databases.query(file, "SELECT 1; SELECT nope FROM players; SELECT 2");
  assert.equal(failed.length, 2);
  assert.match(failed[1].error, /no such column: nope/);

  // The schema: tables and views, columns, row counts, triggers.
  const schema = await databases.schema(file);
  assert.deepEqual(schema.tables.map((table) => `${table.kind}:${table.name}:${table.rows}`), ['table:log:2', 'table:players:2', 'table:settings:1', 'view:leaders:null']);
  const players = schema.tables.find((table) => table.name === 'players');
  assert.deepEqual(players.columns.map((column) => [column.name, column.type, column.notNull, column.primaryKey, column.defaultValue]),
    [['id', 'INTEGER', false, 1, null], ['name', 'TEXT', true, 0, null], ['score', 'REAL', false, 0, '0'], ['avatar', 'BLOB', false, 0, null], ['big', 'INTEGER', false, 0, null]]);
  assert.equal(schema.tables.find((table) => table.name === 'settings').withoutRowid, true);
  assert.deepEqual(schema.triggers.map((trigger) => trigger.name), ['logged']);
  assert.equal(schema.readOnly, false);

  // Rows a page at a time, sorted and filtered, with their keys.
  const page = await databases.rows(file, 'players', { orderBy: 'score', descending: true, where: 'score > 1 -- a note that must not end the LIMIT' });
  assert.deepEqual(page.columns, ['id', 'name', 'score', 'avatar', 'big']);
  assert.deepEqual(page.rows.map((row) => row[1]), ['ada', 'linus']);
  assert.deepEqual(page.keyColumns, ['rowid']);
  assert.deepEqual(page.keys, [[1], [2]]);
  assert.equal(page.total, 2);
  const view = await databases.rows(file, 'leaders', {});
  assert.equal(view.keys, null);
  const keyed = await databases.rows(file, 'settings', {});
  assert.deepEqual([keyed.keyColumns, keyed.keys], [['key'], [['volume']]]);

  // Edits: a value changed (SQLite's affinity makes '30' a number in a REAL
  // column), NULL set, a row added and rows deleted; a WITHOUT ROWID table by
  // its key; a view refused.
  assert.deepEqual(await databases.edit(file, { kind: 'update', table: 'players', key: [2], column: 'score', value: '30' }), { changes: 1 });
  await databases.edit(file, { kind: 'update', table: 'players', key: [1], column: 'avatar', value: null });
  await databases.edit(file, { kind: 'insert', table: 'players', values: { name: 'grace' } });
  await databases.edit(file, { kind: 'update', table: 'settings', key: ['volume'], column: 'value', value: '9' });
  const after = await databases.query(file, "SELECT name, score, typeof(score), avatar FROM players ORDER BY id; SELECT value FROM settings; SELECT count(*) FROM log");
  assert.deepEqual(after[0].rows, [['ada', 12.5, 'real', null], ['linus', 30, 'real', null], ['grace', 0, 'real', null]]);
  assert.deepEqual(after[1].rows, [['9']]);
  assert.deepEqual(after[2].rows, [[3]]);
  assert.deepEqual(await databases.edit(file, { kind: 'delete', table: 'players', keys: [[1], [3]] }), { changes: 2 });
  await assert.rejects(databases.edit(file, { kind: 'update', table: 'leaders', key: [1], column: 'name', value: 'x' }), /view/);
  await assert.rejects(databases.edit(file, { kind: 'insert', table: 'players', values: { score: '1' } }), /NOT NULL/);

  // One elsewhere is only read; a file that is not SQLite is refused.
  await databases.query(elsewhere, 'SELECT 1').catch(() => undefined);
  databases.close(elsewhere);
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(elsewhere).exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)');
  assert.equal((await databases.schema(elsewhere)).readOnly, true);
  const refused = await databases.query(elsewhere, 'INSERT INTO t VALUES (2)');
  assert.match(refused[0].error, /readonly/);
  await assert.rejects(databases.schema(notSqlite), /not a database/);
} finally {
  databases.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log('Database tests passed.');
