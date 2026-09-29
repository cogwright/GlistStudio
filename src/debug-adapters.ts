import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// A program that speaks the Debug Adapter Protocol over stdio. The two kinds
// take slightly different launch arguments.
export interface DebugAdapter {
  command: string;
  args: string[];
  flavor: 'lldb' | 'gdb';
}

const onPath = (name: string, env: NodeJS.ProcessEnv): string | null => {
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
};

// lldb-dap, which Xcode ships and LLVM installs, was lldb-vscode before
// LLVM 18, and Linux distributions add the version to either name. GDB speaks
// DAP itself from version 14. The GDB Settings installs on Windows comes first.
export const findDebugAdapter = async (env: NodeJS.ProcessEnv, installedGdb?: string | null): Promise<DebugAdapter | null> => {
  if (installedGdb && existsSync(installedGdb)) return { command: installedGdb, args: ['--interpreter=dap'], flavor: 'gdb' };
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('xcrun', ['--find', 'lldb-dap']);
      if (stdout.trim()) return { command: stdout.trim(), args: [], flavor: 'lldb' };
    } catch { /* This Xcode has none; look on PATH. */ }
  }
  const names = ['lldb-dap', 'lldb-vscode'];
  for (let version = 30; version >= 14; version -= 1) names.push(`lldb-dap-${version}`, `lldb-vscode-${version}`);
  for (const name of names) {
    const found = onPath(name, env);
    if (found) return { command: found, args: [], flavor: 'lldb' };
  }
  const gdb = onPath('gdb', env);
  if (gdb) {
    try {
      const { stdout } = await run(gdb, ['--version'], { env });
      if (Number(/(\d+)\.\d+/.exec(stdout)?.[1]) >= 14) return { command: gdb, args: ['--interpreter=dap'], flavor: 'gdb' };
    } catch { /* Not a usable gdb. */ }
  }
  return null;
};
