import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ignoredInGitDir, ignoredInProject } from '../src/git-service.ts';
import { watchTree } from '../src/tree-watch.ts';

// The project's watch: what it leaves out; changes reported by path, in folders
// made after it started too, never from the build, clangd's index or Git's
// objects, and none after it is closed. On Linux, where it watches folder by
// folder, a clangd restart's index rewrite and 2,000 files copied into assets
// leave the event loop free, with a watch per folder rather than per file.
// Run with jiti.

const wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const until = async (test, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!test() && Date.now() < end) await wait(20);
  return test();
};

// What is left out, by path in the project, with either separator.
for (const relative of ['_build', '_build/Release/app.o', '_build/Release/.cache/clangd/index/gCanvas.h.idx', '.cache/clangd/index/a.idx',
  'node_modules/x/index.js', '.git/objects/ab/cdef', '.git/logs/HEAD', '_build\\Release\\app.o', '.git\\objects\\ab']) {
  assert.ok(ignoredInProject(relative), `${relative} is left out`);
}
for (const relative of ['src/main.cpp', 'assets/_build.png', 'src/_build/notes.txt', '.git/HEAD', '.git/index', '.git/refs/heads/main', '.gitignore', 'CMakeLists.txt']) {
  assert.ok(!ignoredInProject(relative), `${relative} is watched`);
}
assert.ok(ignoredInGitDir('objects/ab/cdef') && ignoredInGitDir('logs/HEAD') && ignoredInGitDir('logs'));
assert.ok(!ignoredInGitDir('HEAD') && !ignoredInGitDir('refs/heads/main') && !ignoredInGitDir('index'));

const project = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'gs-tree-watch-')));
  for (const folder of ['src', 'assets', '_build/Release/.cache/clangd/index', '.git/objects/ab']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, 'src', 'main.cpp'), 'int main() {}\n');
  return root;
};

// Folder by folder (Linux's way, tried on macOS too), and the system's own recursive watch.
// Windows keeps a watched folder from being deleted, so it has only its own.
const ways = process.platform === 'win32' ? [false] : process.platform === 'linux' ? [true] : [true, false];
for (const byFolder of ways) {
  const root = project();
  const seen = [];
  const watch = watchTree(root, ignoredInProject, (relative) => seen.push(relative.replace(/\\/g, '/')), byFolder);
  const label = byFolder ? 'by folder' : 'recursive';
  try {
    await wait(300);
    writeFileSync(path.join(root, 'src', 'main.cpp'), 'int main() { return 0; }\n');
    assert.ok(await until(() => seen.includes('src/main.cpp')), `${label}: a change in src is reported (${seen})`);

    seen.length = 0;
    writeFileSync(path.join(root, '_build', 'Release', 'app.o'), 'o');
    writeFileSync(path.join(root, '_build', 'Release', '.cache', 'clangd', 'index', 'main.cpp.idx'), 'i');
    writeFileSync(path.join(root, '.git', 'objects', 'ab', 'cdef'), 'g');
    writeFileSync(path.join(root, 'assets', 'marker.txt'), 'm');
    assert.ok(await until(() => seen.includes('assets/marker.txt')), `${label}: a change in assets is reported`);
    await wait(200);
    assert.deepEqual(seen.filter((relative) => ignoredInProject(relative)), [], `${label}: nothing from the build, clangd's index or Git's objects`);

    // A folder made after the watch started, and one inside it, are watched too.
    mkdirSync(path.join(root, 'src', 'made', 'deeper'), { recursive: true });
    await wait(300);
    writeFileSync(path.join(root, 'src', 'made', 'deeper', 'enemy.cpp'), 'int enemy;\n');
    assert.ok(await until(() => seen.includes('src/made/deeper/enemy.cpp')), `${label}: a change in a folder made since is reported (${seen.slice(-5)})`);

    // A folder deleted is reported; made again, it is watched again.
    seen.length = 0;
    rmSync(path.join(root, 'src', 'made'), { recursive: true });
    assert.ok(await until(() => seen.some((relative) => relative.startsWith('src/made'))), `${label}: a folder deleted is reported`);
    mkdirSync(path.join(root, 'src', 'made'));
    await wait(300);
    writeFileSync(path.join(root, 'src', 'made', 'again.cpp'), 'int again;\n');
    assert.ok(await until(() => seen.includes('src/made/again.cpp')), `${label}: made again, it is watched again`);
  } finally {
    watch.close();
  }
  seen.length = 0;
  writeFileSync(path.join(root, 'src', 'after.cpp'), 'int after;\n');
  await wait(300);
  assert.deepEqual(seen, [], `${label}: nothing after it is closed`);
  rmSync(root, { recursive: true, force: true });
}

// Linux: what froze the backend with Node's recursive watch.
if (process.platform === 'linux') {
  const root = project();
  const index = path.join(root, '_build', 'Release', '.cache', 'clangd', 'index');
  for (let shard = 0; shard < 1940; shard += 1) writeFileSync(path.join(index, `shard${shard}.idx`), 'i');
  for (let folder = 0; folder < 10; folder += 1) mkdirSync(path.join(root, 'src', `part${folder}`));
  const inotifyWatches = () => readdirSync('/proc/self/fdinfo').reduce((count, fd) => {
    try { return count + (readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^inotify /gm) ?? []).length; } catch { return count; }
  }, 0);
  const before = inotifyWatches();
  let reported = 0;
  const watch = watchTree(root, ignoredInProject, () => { reported += 1; });
  try {
    await wait(500);
    const watches = inotifyWatches() - before;
    // src, its ten parts, assets, .git and the root: never the 1,940 shards, nor a watch per file.
    assert.ok(watches <= 20, `a watch per folder, the build left out: ${watches}`);

    let worst = 0;
    let last = performance.now();
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 10); last = now; }, 10);
    // Another process, as clangd and a file manager are: every shard written again through a
    // file renamed over it, then 2,000 files copied into assets.
    const writer = `
      const fs = require('node:fs');
      for (let i = 0; i < 1940; i += 1) { const tmp = ${JSON.stringify(index)} + '/shard' + i + '.idx.tmp'; fs.writeFileSync(tmp, 'y'.repeat(2000)); fs.renameSync(tmp, ${JSON.stringify(index)} + '/shard' + i + '.idx'); }
      for (let i = 0; i < 2000; i += 1) fs.writeFileSync(${JSON.stringify(path.join(root, 'assets'))} + '/sprite' + i + '.png', 'p'.repeat(2000));
    `;
    await new Promise((resolve, reject) => spawn(process.execPath, ['-e', writer], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      .once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)))));
    await until(() => reported >= 2000, 5000);
    await wait(300);
    clearInterval(tick);
    assert.ok(reported >= 2000, `the copied assets are reported: ${reported}`);
    assert.ok(worst < 500, `the event loop is never held long: ${Math.round(worst)} ms`);
    assert.ok(inotifyWatches() - before <= 20, 'still a watch per folder after 2,000 files');
  } finally {
    watch.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('Tree watch tests passed.');
