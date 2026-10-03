import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { descendantsOf, parseProcessRows } from '../src/process-tree.ts';
import { clangdIndexFolders, createRepairChecks, gitRunningIn, lockAge, lockVerdict } from '../src/repair-checks.ts';
import { repairLog, repairSummary, runRepair, say } from '../src/repair-runner.ts';

// Help > Repair IDE: the runner's states and words, deciding a Git lock was
// left behind and removing it, clangd's index, and the processes under the
// backend that a restart ends. Run with jiti.

const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8')).interface;
const word = (key) => en[key] ?? key;

// Words: placeholders filled, each time it appears; an unknown key is itself.
assert.equal(say({ key: 'repairGitRemoved', values: { name: 'App' } }, word), 'Git had left a lock file in App, which stopped every Git action. It was removed.');
assert.equal(say({ key: 'x {a} {a}', values: { a: '1' } }, (key) => key), 'x 1 1');

// The runner: each check waits, is checked, then says what it found; what a
// check says while it works shows meanwhile; one that throws is a problem
// saying why, and the rest still run.
const seen = [];
const steps = await runRepair([
  { id: 'one', title: 'repairBackend', run: async (_found, doing) => { doing({ key: 'repairBackendRestarting' }); return { state: 'fixed', messages: [{ key: 'repairBackendRestarted' }] }; } },
  { id: 'two', title: 'repairClangd', run: async () => { throw new Error("Error invoking remote method 'repair:state': Error: no backend"); } },
  { id: 'three', title: 'repairGit', run: async (found) => ({ state: found.get('one')?.state === 'fixed' ? 'ok' : 'problem', messages: [{ key: 'repairGitOk' }] }) },
], (now) => seen.push(now.map((step) => `${step.id}:${step.state}:${step.messages.map((each) => each.key).join('+')}`).join(' ')));
assert.deepEqual(seen, [
  'one:checking: two:waiting: three:waiting:',
  'one:checking:repairBackendRestarting two:waiting: three:waiting:',
  'one:fixed:repairBackendRestarted two:waiting: three:waiting:',
  'one:fixed:repairBackendRestarted two:checking: three:waiting:',
  'one:fixed:repairBackendRestarted two:problem:repairCheckFailed three:waiting:',
  'one:fixed:repairBackendRestarted two:problem:repairCheckFailed three:checking:',
  'one:fixed:repairBackendRestarted two:problem:repairCheckFailed three:ok:repairGitOk',
]);
assert.deepEqual(steps[1].messages, [{ key: 'repairCheckFailed', values: { error: 'no backend' } }]);
// A dialog closed meanwhile: what is left stays waiting.
let closed = false;
const stopped = await runRepair([
  { id: 'a', title: 'repairBackend', run: async () => { closed = true; return { state: 'ok', messages: [] }; } },
  { id: 'b', title: 'repairGit', run: async () => assert.fail('ran after closing') },
], () => undefined, () => closed);
assert.deepEqual(stopped.map((step) => step.state), ['ok', 'waiting']);

// The summary: fine, fixed, or something for the person.
const state = (...states) => states.map((each, index) => ({ id: String(index), title: 'repairGit', state: each, messages: [], actions: [] }));
assert.equal(repairSummary(state('ok', 'skipped')).key, 'repairAllWell');
assert.equal(repairSummary(state('ok', 'fixed')).key, 'repairAllFixed');
assert.equal(repairSummary(state('problem', 'ok')).key, 'repairNeedsYou');
assert.equal(repairSummary(state('fixed', 'problem')).key, 'repairFixedSome');

// Copy Details' section, in English.
const log = repairLog(steps, en, '2026-10-03T12:00:00.000Z', [{ key: 'repairIndexRebuilt' }]);
assert.equal(log, [
  '### Repair IDE',
  'time: 2026-10-03T12:00:00.000Z',
  '- Background work: fixed. Background work was not answering. It was started again, and the project is open again.',
  '- Code help (clangd): problem. This check could not finish: no backend',
  '- Git: ok. No lock files are left behind.',
  '- The index was deleted. Code help builds it again in the background, which takes a few minutes.',
  'summary: Some things were fixed; the ones marked need you.',
  '',
].join('\n'));

// A Git lock: a running git keeps it, whatever its age; without one, it is
// left behind once a minute old.
assert.equal(lockVerdict(10 * lockAge, true), 'busy');
assert.equal(lockVerdict(lockAge - 1, false), 'recent');
assert.equal(lockVerdict(lockAge, false), 'stale');
// A git in the repository, or one whose folder cannot be told, could be holding it.
assert.equal(gitRunningIn([{ cwd: '/work/App/src' }], ['/work/App', '/work/App/.git']), true);
assert.equal(gitRunningIn([{ cwd: '/work/AppTwo' }, { cwd: '/home' }], ['/work/App']), false);
assert.equal(gitRunningIn([{ cwd: null }], ['/work/App']), true);
assert.equal(gitRunningIn([], ['/work/App']), false);

// Processes under the backend, and theirs, but nothing above it or beside it.
const rows = parseProcessRows('    1     0\n  100     1\n  200   100\n  201   100\n  300   200\n  400     1\n  bad line\n');
assert.deepEqual(rows, [[1, 0], [100, 1], [200, 100], [201, 100], [300, 200], [400, 1]].filter(([pid, parent]) => parent > 0 && pid > 0));
assert.deepEqual(descendantsOf(rows, 100).sort(), [200, 201, 300]);
assert.deepEqual(descendantsOf(rows, 300), []);
assert.deepEqual(descendantsOf([[5, 6], [6, 5]], 5), [6]);

// clangd's index: beside the compilation database in each build folder, and in the project.
assert.deepEqual(clangdIndexFolders('/p', ['/p/_build/Release']), [path.join('/p/_build/Release/.cache/clangd/index'), path.join('/p/.cache/clangd/index')]);

// Against a real repository: an old lock is removed, a new one kept, and
// only looked at when not asked to fix.
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'gs-repair-')));
try {
  const project = path.join(scratch, 'App');
  mkdirSync(path.join(project, '_build', 'Release'), { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const lock = path.join(project, '.git', 'index.lock');
  const old = (file) => { const then = (Date.now() - 2 * lockAge) / 1000; utimesSync(file, then, then); };
  let clangdStopped = 0;
  const checks = createRepairChecks({
    projectRoot: () => project,
    dependencies: async () => [{ name: 'GlistEngine', kind: 'engine', path: path.join(scratch, 'GlistEngine'), exists: false }],
    environment: () => process.env,
    processes: () => ({ clangd: true, building: false, running: false, debugging: false, terminals: ['shell'] }),
    buildFolders: (root) => [path.join(root, '_build', 'Release'), path.join(root, '_build', 'Debug')],
    stopClangd: async () => { clangdStopped += 1; },
  });
  assert.deepEqual(await checks.repairGit(true), { installed: true, locks: [] });
  writeFileSync(lock, '');
  assert.deepEqual((await checks.repairGit(true)).locks, [{ repository: 'App', file: 'index.lock', state: 'recent' }]);
  old(lock);
  assert.deepEqual((await checks.repairGit(false)).locks, [{ repository: 'App', file: 'index.lock', state: 'stale' }]);
  assert.ok(existsSync(lock));
  writeFileSync(path.join(project, '.git', 'HEAD.lock'), '');
  old(path.join(project, '.git', 'HEAD.lock'));
  assert.deepEqual((await checks.repairGit(true)).locks.map((each) => `${each.file}:${each.state}`), ['index.lock:removed', 'HEAD.lock:removed']);
  assert.ok(!existsSync(lock));

  // The state: what runs, and whether clangd has a compilation database.
  assert.deepEqual(checks.repairState(), { clangd: true, building: false, running: false, debugging: false, terminals: ['shell'], project, compileCommands: false });
  writeFileSync(path.join(project, '_build', 'Release', 'compile_commands.json'), '[]');
  assert.equal(checks.repairState().compileCommands, true);

  // The index deleted, clangd stopped first; a folder outside the project, linked in, is left alone.
  const index = path.join(project, '_build', 'Release', '.cache', 'clangd', 'index');
  mkdirSync(index, { recursive: true });
  writeFileSync(path.join(index, 'gCanvas.cpp.idx'), 'x');
  const outside = path.join(scratch, 'elsewhere');
  mkdirSync(outside);
  mkdirSync(path.join(project, '.cache', 'clangd'), { recursive: true });
  // Windows makes links only with a privilege; there the link is left out.
  let linked = true;
  try { symlinkSync(outside, path.join(project, '.cache', 'clangd', 'index'), 'dir'); } catch { linked = false; }
  assert.deepEqual(await checks.clearClangdIndex(), [index]);
  assert.equal(clangdStopped, 1);
  assert.ok(!existsSync(index) && (!linked || existsSync(outside)));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('Repair IDE tests passed.');
