import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compareDatabases, diffDatabase, diffRows, fileStamp } from '../src/database-diff.ts';

// A database compared between two versions: tables, schema and rows added,
// removed and changed, counted by SQLite; neither version written to, nor
// anything left beside them or in the temporary folder.

const root = mkdtempSync(path.join(tmpdir(), 'glist-database-diff-test-'));
const at = (name) => path.join(root, name);
const make = (name, sql) => {
  const db = new DatabaseSync(at(name));
  db.exec(sql);
  db.close();
  return at(name);
};
const ours = () => readdirSync(tmpdir()).filter((name) => name.startsWith('glist-studio-db-diff-')).sort();
const leftBefore = ours();
// Every file beside one, with its bytes and when it was written.
const besides = (file) => readdirSync(path.dirname(file)).filter((name) => name.startsWith(path.basename(file)))
  .map((name) => `${name}:${statSync(path.join(path.dirname(file), name)).mtimeMs}:${readFileSync(path.join(path.dirname(file), name)).toString('base64')}`).sort();
const sql = (file, text) => { const db = new DatabaseSync(file); try { db.exec(text); } finally { db.close(); } };
const table = (diff, name) => diff.tables.find((entry) => entry.name === name);
const brief = (rows) => rows.rows.map((row) => `${row.state}:${JSON.stringify(row.before)}>${JSON.stringify(row.after)}:${row.changed.join(',')}`);

try {
  const base = make('base.db', `
    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, score REAL, avatar BLOB, big INTEGER, gone TEXT);
    INSERT INTO players VALUES (1, 'ada', 1, x'0102', 9007199254740993, 'x'), (2, 'linus', 2, NULL, 1, 'y'), (3, 'grace', 3, x'00', 5, 'z'), (4, 'alan', 4, NULL, 4, 'w');
    CREATE TABLE notes (body TEXT);
    INSERT INTO notes VALUES ('first'), ('second'), ('third');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
    INSERT INTO settings VALUES ('volume', 7), ('lang', 'en');
    CREATE TABLE old_stuff (a);
    INSERT INTO old_stuff VALUES (1), (2);
    CREATE TABLE "target" ("say ""hi""" TEXT);
    INSERT INTO "target" VALUES ('hello');
    CREATE TABLE same (id INTEGER PRIMARY KEY, v);
    INSERT INTO same VALUES (1, 1);
    CREATE VIEW leaders AS SELECT name FROM players ORDER BY score DESC;
    CREATE VIEW calm AS SELECT 1;
    CREATE INDEX players_score ON players (score);`);
  const changed = make('changed.db', `
    CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, score REAL, avatar BLOB, big INTEGER, level INTEGER);
    -- 1: a BLOB's bytes changed, its size not; 2: removed; 3: a text changed in case only and a big integer changed;
    -- 4: score 4 kept as the integer it was (1 and 1.0 are the same value); 5: added.
    INSERT INTO players VALUES (1, 'ada', 1, x'0103', 9007199254740993, 1), (3, 'GRACE', 3, x'00', 9007199254740995, 1), (4, 'alan', 4.0, NULL, 4, 1), (5, 'barbara', 5, x'ffffff', 2, 1);
    CREATE TABLE notes (body TEXT);
    INSERT INTO notes VALUES ('first'), ('second changed'), ('third'), ('fourth');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value) WITHOUT ROWID;
    INSERT INTO settings VALUES ('volume', 9), ('theme', 'dark');
    CREATE TABLE new_stuff (id INTEGER PRIMARY KEY, label TEXT);
    INSERT INTO new_stuff VALUES (10, 'a'), (11, 'b');
    CREATE TABLE "target" ("say ""hi""" TEXT);
    INSERT INTO "target" VALUES ('hello there');
    CREATE TABLE same (id INTEGER PRIMARY KEY, v);
    INSERT INTO same VALUES (1, 1);
    CREATE VIEW leaders AS SELECT name, score FROM players ORDER BY score DESC;
    CREATE VIEW calm AS SELECT 1;
    CREATE INDEX players_level ON players (level);`);

  const diff = await compareDatabases(base, changed);
  assert.deepEqual(diff.base, { missing: false });
  assert.deepEqual(diff.target, { missing: false });
  assert.equal(diff.rowLimit, diffRows);
  assert.deepEqual(diff.tables.map((entry) => `${entry.kind}:${entry.name}:${entry.state}`), [
    'table:new_stuff:added', 'table:notes:changed', 'table:old_stuff:removed', 'table:players:changed', 'table:same:unchanged',
    'table:settings:changed', 'table:target:changed', 'view:calm:unchanged', 'view:leaders:changed',
  ]);

  // By primary key: the cells that differ byte for byte, BLOBs by size, big integers as text.
  const players = table(diff, 'players');
  assert.equal(players.rows.match, 'key');
  assert.deepEqual(players.rows.columns, ['id', 'name', 'score', 'avatar', 'big']);
  assert.equal(players.rows.keyCount, 1);
  assert.deepEqual([players.rows.added, players.rows.removed, players.rows.changed], [1, 1, 2]);
  assert.deepEqual(brief(players.rows), [
    'changed:[1,"ada",1,{"blob":2},"9007199254740993"]>[1,"ada",1,{"blob":2},"9007199254740993"]:3',
    'removed:[2,"linus",2,null,1]>null:',
    'changed:[3,"grace",3,{"blob":1},5]>[3,"GRACE",3,{"blob":1},"9007199254740995"]:1,4',
    'added:null>[5,"barbara",5,{"blob":3},2]:',
  ]);
  // Columns added and removed are a schema change, compared on what both have.
  assert.deepEqual([players.addedColumns, players.removedColumns], [['level'], ['gone']]);
  assert.match(players.before, /gone TEXT/);
  assert.match(players.after, /level INTEGER/);
  assert.deepEqual(players.related.map((item) => `${item.kind}:${item.name}:${item.before !== null}:${item.after !== null}`),
    ['index:players_level:false:true', 'index:players_score:true:false']);

  // By row number, without a key.
  const notes = table(diff, 'notes');
  assert.equal(notes.rows.match, 'rowid');
  assert.deepEqual(notes.rows.columns, ['rowid', 'body']);
  assert.deepEqual(brief(notes.rows), ['changed:[2,"second"]>[2,"second changed"]:1', 'added:null>[4,"fourth"]:']);

  // A WITHOUT ROWID table by its key.
  const settings = table(diff, 'settings');
  assert.equal(settings.rows.match, 'key');
  assert.deepEqual(brief(settings.rows), ['removed:["lang","en"]>null:', 'added:null>["theme","dark"]:', 'changed:["volume",7]>["volume",9]:1']);

  // Tables added and removed, all their rows with them.
  assert.deepEqual([table(diff, 'new_stuff').rows.added, table(diff, 'new_stuff').before], [2, null]);
  assert.deepEqual(brief(table(diff, 'new_stuff').rows), ['added:null>[10,"a"]:', 'added:null>[11,"b"]:']);
  assert.deepEqual([table(diff, 'old_stuff').rows.removed, table(diff, 'old_stuff').rows.match, table(diff, 'old_stuff').after], [2, 'rowid', null]);
  // Names quoted however they are spelled, a table called target included.
  assert.deepEqual(table(diff, 'target').rows.columns, ['rowid', 'say "hi"']);
  assert.equal(table(diff, 'target').rows.changed, 1);
  // A view: its SQL only.
  assert.equal(table(diff, 'leaders').rows, undefined);
  assert.match(table(diff, 'leaders').after, /name, score/);
  assert.deepEqual([table(diff, 'same').rows.added, table(diff, 'same').rows.removed, table(diff, 'same').rows.changed, table(diff, 'same').related], [0, 0, 0, []]);

  // A WITHOUT ROWID table whose key changed: matched on all of its columns.
  const keyed = make('keyed-a.db', "CREATE TABLE pairs (a, b, c, PRIMARY KEY (a)) WITHOUT ROWID; INSERT INTO pairs VALUES (1, 1, 'x'), (2, 2, 'y');");
  const rekeyed = make('keyed-b.db', "CREATE TABLE pairs (a, b, c, PRIMARY KEY (a, b)) WITHOUT ROWID; INSERT INTO pairs VALUES (1, 1, 'x'), (2, 2, 'z');");
  const pairs = table(await compareDatabases(keyed, rekeyed), 'pairs');
  assert.deepEqual([pairs.rows.match, pairs.rows.added, pairs.rows.removed, pairs.rows.changed], ['columns', 1, 1, 0]);
  assert.deepEqual(brief(pairs.rows), ['removed:[2,2,"y"]>null:', 'added:null>[2,2,"z"]:']);

  // Missing versions: everything added, or everything removed.
  const added = await compareDatabases(null, changed);
  assert.deepEqual(added.base, { missing: true });
  assert.ok(added.tables.every((entry) => entry.state === 'added'), JSON.stringify(added.tables.map((entry) => entry.state)));
  assert.equal(table(added, 'players').rows.added, 4);
  const removed = await compareDatabases(base, null);
  assert.deepEqual(removed.target, { missing: true });
  assert.ok(removed.tables.every((entry) => entry.state === 'removed'));
  assert.deepEqual((await compareDatabases(null, null)).tables, []);
  // An empty file is an empty database.
  writeFileSync(at('empty.db'), '');
  assert.ok((await compareDatabases(at('empty.db'), changed)).tables.every((entry) => entry.state === 'added'));

  // A Git LFS pointer, and a file that is not SQLite, are said to be so.
  writeFileSync(at('pointer.db'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n');
  writeFileSync(at('text.db'), 'just some text, not a database at all');
  const pointer = await compareDatabases(at('pointer.db'), changed);
  assert.deepEqual([pointer.base, pointer.tables], [{ missing: false, problem: 'lfs' }, []]);
  assert.deepEqual((await compareDatabases(base, at('text.db'))).target, { missing: false, problem: 'notDatabase' });

  // At most so many rows a table, counted exactly however many.
  const many = make('many-a.db', `CREATE TABLE t (id INTEGER PRIMARY KEY, v);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO t SELECT i, i FROM n;`);
  const more = make('many-b.db', `CREATE TABLE t (id INTEGER PRIMARY KEY, v);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1250) INSERT INTO t SELECT i, i FROM n;
    DELETE FROM t WHERE id <= 30; UPDATE t SET v = -v WHERE id BETWEEN 501 AND 520;`);
  const capped = table(await compareDatabases(many, more), 't');
  assert.deepEqual([capped.rows.added, capped.rows.removed, capped.rows.changed, capped.rows.rows.length], [250, 30, 20, diffRows]);
  assert.deepEqual([capped.rows.rows[0].state, capped.rows.rows[30].state, capped.rows.rows[50].state], ['removed', 'changed', 'added']);
  assert.equal((await compareDatabases(many, more, { rows: 5 })).tables[0].rows.rows.length, 5);

  // The file on disk is read where it is, nothing written to it or beside it:
  // in rollback mode; in WAL mode closed cleanly, where opening it read-only
  // would leave a -wal and -shm behind; and in WAL mode while open elsewhere,
  // writes still only in its -wal, which are read too.
  const rollback = make('rollback.db', 'CREATE TABLE t (id INTEGER PRIMARY KEY, v); INSERT INTO t VALUES (1, 1);');
  const before = besides(rollback);
  assert.equal(table(await compareDatabases(base, rollback), 't').state, 'added');
  assert.deepEqual(besides(rollback), before);
  const clean = make('clean.db', "PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v); INSERT INTO t VALUES (1, 'clean');");
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('clean.db')), ['clean.db']);
  const cleanBefore = besides(clean);
  const cleanDiff = await compareDatabases(rollback, clean);
  assert.deepEqual(brief(table(cleanDiff, 't').rows), ['changed:[1,1]>[1,"clean"]:1']);
  assert.deepEqual(besides(clean), cleanBefore);
  const held = new DatabaseSync(at('held.db'));
  held.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (id INTEGER PRIMARY KEY, v); INSERT INTO t VALUES (1, 'held');");
  held.exec("INSERT INTO t VALUES (2, 'only in the wal')");
  // While it is open here the -shm is shared with this process's connection, which
  // SQLite writes to; from another process, as a Glist app, it is left alone too.
  const heldBefore = besides(at('held.db')).filter((entry) => !entry.startsWith('held.db-shm'));
  const heldDiff = await compareDatabases(rollback, at('held.db'));
  assert.deepEqual(brief(table(heldDiff, 't').rows), ['changed:[1,1]>[1,"held"]:1', 'added:null>[2,"only in the wal"]:']);
  assert.deepEqual(besides(at('held.db')).filter((entry) => !entry.startsWith('held.db-shm')), heldBefore);
  // What tells a diff its file changed: the same until a write, the file's or
  // its -wal's, and not moved by reading.
  const stamped = await fileStamp(at('held.db'));
  assert.match(stamped, /^\d+:[\d.]+\/\d+:[\d.]+$/);
  await compareDatabases(rollback, at('held.db'));
  assert.equal(await fileStamp(at('held.db')), stamped);
  held.exec("INSERT INTO t VALUES (3, 'later')");
  assert.notEqual(await fileStamp(at('held.db')), stamped);
  const rollbackStamp = await fileStamp(rollback);
  assert.match(rollbackStamp, /\/-$/);
  sql(rollback, "UPDATE t SET v = 2");
  assert.notEqual(await fileStamp(rollback), rollbackStamp);
  sql(rollback, "UPDATE t SET v = 1");
  assert.equal(await fileStamp(at('nowhere.db')), '-/-');
  // Open in another process, as a Glist app has it: its -shm is not written to either.
  const writer = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(at('app.db'))});
    db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (id INTEGER PRIMARY KEY, v); INSERT INTO t VALUES (1, 'app')");
    db.exec("INSERT INTO t VALUES (2, 'app wal')");
    console.log('ready');
    process.stdin.once('data', () => { db.close(); process.exit(0); });`], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((resolve) => writer.stdout.once('data', resolve));
  const appBefore = besides(at('app.db'));
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('app.db')), ['app.db', 'app.db-shm', 'app.db-wal']);
  assert.equal(table(await compareDatabases(rollback, at('app.db')), 't').rows.added, 1);
  assert.deepEqual(besides(at('app.db')), appBefore);
  writer.stdin.end('done\n');
  await new Promise((resolve) => writer.once('exit', resolve));
  // A -wal with no -shm: nothing has it open, so both are read from copies.
  for (const suffix of ['', '-wal']) copyFileSync(`${at('held.db')}${suffix}`, `${at('orphan.db')}${suffix}`);
  held.close();
  const orphanBefore = besides(at('orphan.db'));
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('orphan.db')), ['orphan.db', 'orphan.db-wal']);
  assert.equal(table(await compareDatabases(rollback, at('orphan.db')), 't').rows.added, 2);
  assert.deepEqual(besides(at('orphan.db')), orphanBefore);

  // From git and the disk: a commit's version copied to a folder of our own,
  // taken away after; none where the commit has no such file.
  const asked = [];
  const versions = {
    blob: async (revision, file) => { asked.push(`${revision}:${path.basename(file)}`); return revision === 'HEAD' ? readFileSync(base) : null; },
    working: async (file) => (existsSync(file) ? file : null),
    unavailable: () => 'unavailable',
  };
  const working = await diffDatabase(versions, changed, 'HEAD', null, at('renamed-from.db'));
  assert.deepEqual(asked, ['HEAD:renamed-from.db']);
  assert.equal(table(working, 'players').rows.changed, 2);
  const deleted = await diffDatabase(versions, at('nowhere.db'), 'HEAD', null);
  assert.ok(deleted.target.missing && deleted.tables.every((entry) => entry.state === 'removed'));
  const notInCommit = await diffDatabase(versions, changed, 'abc1234', 'HEAD');
  assert.ok(notInCommit.base.missing && notInCommit.tables.every((entry) => entry.state === 'added'));
  // And when it fails, too.
  await assert.rejects(diffDatabase({ ...versions, working: async () => { throw new Error('outside the project'); } }, changed, 'HEAD', null), /outside the project/);
  const broken = make('broken.db', 'CREATE TABLE t (a)');
  writeFileSync(broken, Buffer.concat([readFileSync(broken).subarray(0, 100), Buffer.alloc(4000, 7)]));
  await assert.rejects(diffDatabase({ ...versions, working: async () => broken }, broken, 'HEAD', null));
  assert.deepEqual(ours(), leftBefore, 'temporary folders left behind');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Database diff tests passed.');
