import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createZstdDecompress } from 'node:zlib';
import pinned from './debugger-packages.json';

// The debugger Settings installs on Windows, where Glist's tools have none:
// GDB from MSYS2's CLANG64 repository, the one zbin's compilers come from.
// Every package is pinned by name and SHA-256 (scripts/pin-debugger.ts), so a
// file that differs in any way is refused rather than run. Nothing here needs
// Electron, so it can be tested on its own.

const run = promisify(execFile);

export type DebuggerRelease = typeof pinned;

export const debuggerRelease: DebuggerRelease = pinned;

export const mirrors = ['https://repo.msys2.org/mingw/clang64/', 'https://mirror.msys2.org/mingw/clang64/'];

const folderFor = (home: string, release: DebuggerRelease): string => path.join(home, 'debugger', `gdb-${release.version}`);

// Written last, so a folder without it is an install that did not finish.
const doneMarker = '.installed';

// The installed GDB, or null.
export const installedDebugger = (home: string, release = debuggerRelease): string | null => {
  const folder = folderFor(home, release);
  return existsSync(path.join(folder, doneMarker)) ? path.join(folder, ...release.program.split('/')) : null;
};

export const removeDebugger = (home: string, release = debuggerRelease): Promise<void> =>
  fs.rm(folderFor(home, release), { recursive: true, force: true });

const fileHash = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  try {
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
  } catch {
    return '';
  }
};

// One package, from the first mirror that has it as pinned.
const download = async (sources: string[], entry: { file: string; sha256: string }, target: string): Promise<void> => {
  if (await fileHash(target) === entry.sha256) return;
  const failures: string[] = [];
  for (const source of sources) {
    try {
      const response = await fetch(source + entry.file, { headers: { 'User-Agent': 'Glist Studio' } });
      if (!response.ok || !response.body) throw new Error(`answered ${response.status}`);
      const hash = createHash('sha256');
      const output = createWriteStream(target);
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise<void>((resolve) => output.once('drain', () => resolve()));
      }
      await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
      if (hash.digest('hex') === entry.sha256) return;
      throw new Error('does not match its pinned SHA-256');
    } catch (error) {
      await fs.rm(target, { force: true });
      failures.push(`${new URL(source).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${entry.file}: ${failures.join('; ')}`);
};

// Windows 10 and later have bsdtar; pacman's own files are left out.
const tarProgram = (): string => (process.platform === 'win32'
  ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar');

const unpack = async (archive: string, folder: string): Promise<void> => {
  const tar = archive.replace(/\.zst$/, '');
  await pipeline(createReadStream(archive), createZstdDecompress(), createWriteStream(tar));
  try {
    await run(tarProgram(), ['-xf', tar, '-C', folder, '--exclude', '.PKGINFO', '--exclude', '.MTREE', '--exclude', '.BUILDINFO', '--exclude', '.INSTALL']);
  } finally {
    await fs.rm(tar, { force: true });
  }
};

// What running GDB never needs: Python's own tests and IDLE, headers, static
// libraries and manuals, most of what the packages hold.
const prune = async (staging: string): Promise<void> => {
  const prefix = path.join(staging, 'clang64');
  const lib = path.join(prefix, 'lib');
  const entries = await fs.readdir(lib).catch((): string[] => []);
  const pythons = entries.filter((name) => /^python3\.\d+$/.test(name)).flatMap((name) => ['test', 'idlelib'].map((part) => path.join(lib, name, part)));
  const archives = entries.filter((name) => name.endsWith('.a')).map((name) => path.join(lib, name));
  const rest = ['include', 'share/man', 'share/doc', 'share/info', 'share/gtk-doc'].map((part) => path.join(prefix, ...part.split('/')));
  await Promise.all([...pythons, ...archives, ...rest].map((target) => fs.rm(target, { recursive: true, force: true })));
};

// Downloads and unpacks every pinned package into a folder of its own, which
// only takes the real folder's place once all of them are in. Other versions
// installed before are removed afterwards.
export const installDebugger = async (
  home: string, report: (text: string) => void, sources = mirrors, release = debuggerRelease,
): Promise<string> => {
  const installed = installedDebugger(home, release);
  if (installed) return installed;
  const parent = path.join(home, 'debugger');
  const downloads = path.join(parent, 'downloads');
  const staging = path.join(parent, `.gdb-${release.version}-installing`);
  await fs.mkdir(downloads, { recursive: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  const total = release.packages.reduce((sum, entry) => sum + entry.size, 0);
  let received = 0;
  for (const entry of release.packages) {
    report(`${entry.file}\n`);
    const archive = path.join(downloads, entry.file);
    await download(sources, entry, archive);
    await unpack(archive, staging);
    received += entry.size;
    report(`  ${Math.round((received / total) * 100)}%\n`);
  }
  await prune(staging);
  await fs.writeFile(path.join(staging, doneMarker), `${release.name} ${release.version}\n`);
  const folder = folderFor(home, release);
  await fs.rm(folder, { recursive: true, force: true });
  await fs.rename(staging, folder);
  await fs.rm(downloads, { recursive: true, force: true });
  for (const entry of await fs.readdir(parent)) {
    if (entry !== path.basename(folder)) await fs.rm(path.join(parent, entry), { recursive: true, force: true });
  }
  return path.join(folder, ...release.program.split('/'));
};
