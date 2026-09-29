import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

// Pins the debugger Settings installs on Windows: GDB from MSYS2's CLANG64
// repository, the one zbin's compilers come from, with every package it needs
// by its file name and SHA-256 from the repository's own database. Writes
// src/debugger-packages.json; run again, with jiti, to move to newer packages.
//   npx jiti scripts/pin-debugger.ts

const repository = 'https://repo.msys2.org/mingw/clang64/';
const root = 'mingw-w64-clang-x86_64-gdb';

const main = async (): Promise<void> => {
  const response = await fetch(`${repository}clang64.db`);
  if (!response.ok) throw new Error(`MSYS2 answered ${response.status}`);
  const folder = mkdtempSync(path.join(tmpdir(), 'glist-pin-'));
  try {
    writeFileSync(path.join(folder, 'clang64.db.tar'), zstdDecompressSync(Buffer.from(await response.arrayBuffer())));
    execFileSync('tar', ['-xf', path.join(folder, 'clang64.db.tar'), '-C', folder]);
    // Each package's desc file: %FIELD% lines, each followed by its values.
    const packages = new Map<string, Record<string, string[]>>();
    const provided = new Map<string, string>();
    readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).forEach((entry) => {
      const fields: Record<string, string[]> = {};
      readFileSync(path.join(folder, entry.name, 'desc'), 'utf8').trim().split(/\n\n+/).forEach((block) => {
        const [key, ...values] = block.split('\n');
        fields[key.replace(/%/g, '')] = values;
      });
      packages.set(fields.NAME[0], fields);
      (fields.PROVIDES ?? []).forEach((name) => provided.set(name.split(/[<>=]/)[0], fields.NAME[0]));
    });
    const find = (dependency: string): string | undefined => {
      const name = dependency.split(/[<>=]/)[0];
      return packages.has(name) ? name : provided.get(name);
    };
    const needed: string[] = [];
    const waiting = [root];
    while (waiting.length > 0) {
      const name = find(waiting.pop() ?? '');
      if (!name || needed.includes(name)) continue;
      needed.push(name);
      waiting.push(...(packages.get(name)?.DEPENDS ?? []));
    }
    const pinned = needed.sort().map((name) => {
      const fields = packages.get(name) ?? {};
      return { file: fields.FILENAME[0], sha256: fields.SHA256SUM[0], size: Number(fields.CSIZE[0]) };
    });
    const gdb = packages.get(root) ?? {};
    const out = path.join(__dirname, '..', 'src', 'debugger-packages.json');
    writeFileSync(out, `${JSON.stringify({ name: 'GDB', version: gdb.VERSION[0], program: 'clang64/bin/gdb.exe', packages: pinned }, null, 2)}\n`);
    const size = pinned.reduce((total, entry) => total + entry.size, 0);
    console.log(`GDB ${gdb.VERSION[0]}: ${pinned.length} packages, ${(size / 1e6).toFixed(1)} MB, written to ${path.relative(process.cwd(), out)}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

void main();
