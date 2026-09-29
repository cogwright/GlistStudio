import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { debuggerRelease, installDebugger, installedDebugger } from '../src/debugger-download.ts';

// Installing the pinned GDB, against a local server serving packages made the
// way MSYS2 makes them: tar, then zstd. Run with jiti.
const root = mkdtempSync(path.join(tmpdir(), 'glist-debugger-'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// What is pinned: MSYS2 package files by SHA-256, GDB and the Python it runs among them.
assert.equal(debuggerRelease.program, 'clang64/bin/gdb.exe');
assert.ok(debuggerRelease.packages.length > 10);
debuggerRelease.packages.forEach((entry) => {
  assert.match(entry.file, /^mingw-w64-clang-x86_64-[\w.+-]+-any\.pkg\.tar\.zst$/);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
});
assert.ok(debuggerRelease.packages.some((entry) => entry.file.startsWith(`mingw-w64-clang-x86_64-gdb-${debuggerRelease.version}-`)));
assert.ok(debuggerRelease.packages.some((entry) => /^mingw-w64-clang-x86_64-python-3/.test(entry.file)));

const makePackage = (name, files) => {
  const folder = path.join(root, 'build', name);
  Object.entries({ '.PKGINFO': `pkgname = ${name}\n`, ...files }).forEach(([file, text]) => {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), text);
  });
  const tar = path.join(root, `${name}.tar`);
  execFileSync('tar', ['-cf', tar, '-C', folder, '.']);
  const data = zstdCompressSync(readFileSync(tar));
  return { file: `${name}-1.0-1-any.pkg.tar.zst`, data, entry: { file: `${name}-1.0-1-any.pkg.tar.zst`, sha256: sha256(data), size: data.length } };
};
const gdb = makePackage('mingw-w64-clang-x86_64-gdb', { 'clang64/bin/gdb.exe': 'gdb\n' });
const python = makePackage('mingw-w64-clang-x86_64-python', { 'clang64/lib/python3.14/os.py': '# os\n' });
const files = new Map([gdb, python].map((made) => [made.file, made.data]));

const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const [, mirror, file] = request.url.split('/');
  // The first mirror lacks Python, so the second one is asked.
  const data = mirror === 'first' && file.includes('python') ? undefined : files.get(file);
  response.writeHead(data ? 200 : 404);
  response.end(data);
});
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const sources = [`${base}/first/`, `${base}/second/`];
const release = (version, packages) => ({ name: 'GDB', version, program: 'clang64/bin/gdb.exe', packages });
const home = path.join(root, 'GlistStudio');
const lines = [];

try {
  // A package that differs from its pin is refused, and nothing is installed.
  const tampered = release('1.0-1', [gdb.entry, { ...python.entry, sha256: '0'.repeat(64) }]);
  await assert.rejects(installDebugger(home, (text) => lines.push(text), sources, tampered), /does not match its pinned SHA-256/);
  assert.equal(installedDebugger(home, tampered), null);
  assert.equal(existsSync(path.join(home, 'debugger', 'gdb-1.0-1')), false);

  // An older install is replaced; pacman's own files stay out; the downloads go.
  mkdirSync(path.join(home, 'debugger', 'gdb-0.9-1'), { recursive: true });
  const good = release('1.0-1', [gdb.entry, python.entry]);
  const program = await installDebugger(home, (text) => lines.push(text), sources, good);
  assert.equal(program, path.join(home, 'debugger', 'gdb-1.0-1', 'clang64', 'bin', 'gdb.exe'));
  assert.equal(installedDebugger(home, good), program);
  assert.equal(readFileSync(program, 'utf8'), 'gdb\n');
  assert.ok(existsSync(path.join(home, 'debugger', 'gdb-1.0-1', 'clang64', 'lib', 'python3.14', 'os.py')));
  assert.equal(existsSync(path.join(home, 'debugger', 'gdb-1.0-1', '.PKGINFO')), false);
  assert.deepEqual(readdirSync(path.join(home, 'debugger')), ['gdb-1.0-1']);
  assert.ok(requests.includes(`/second/${python.file}`), 'the second mirror had what the first lacked');
  assert.ok(lines.some((line) => line.includes('100%')));

  // Installed already: nothing is downloaded again.
  const asked = requests.length;
  assert.equal(await installDebugger(home, () => undefined, sources, good), program);
  assert.equal(requests.length, asked);
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('Debugger download tests passed.');
