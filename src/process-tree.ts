import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

// Ending a process with everything it started, for Repair IDE's restart of a
// window's backend that stopped answering (index.ts). Builds and runs have
// process groups of their own, so they would outlive it: a program nobody can
// stop any more, or a second build in the same folder as the first.

// Every process under one, from a list of process ids with their parents'.
export const descendantsOf = (rows: Array<[number, number]>, root: number): number[] => {
  const children = new Map<number, number[]>();
  rows.forEach(([pid, parent]) => { if (pid !== parent) children.set(parent, [...(children.get(parent) ?? []), pid]); });
  const found: number[] = [];
  const seen = new Set([root]);
  const waiting = [root];
  while (waiting.length > 0) {
    for (const child of children.get(waiting.pop() as number) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      waiting.push(child);
    }
  }
  return found;
};

// ps's 'pid ppid' lines.
export const parseProcessRows = (text: string): Array<[number, number]> => text.split('\n')
  .map((line) => line.trim().split(/\s+/).map(Number))
  .filter((row): row is [number, number] => row.length === 2 && row.every((value) => Number.isInteger(value) && value > 0));

// Linux has them in /proc, which every system has where ps may be missing:
// a stat line is 'pid (name) state ppid ...', and the name can hold anything.
const linuxRows = async (): Promise<Array<[number, number]>> => {
  const rows: Array<[number, number]> = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isInteger(parent)) rows.push([Number(entry), parent]);
  }
  return rows;
};

const processRows = (): Promise<Array<[number, number]>> => (process.platform === 'linux' ? linuxRows()
  : new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parseProcessRows(stdout)));
  }));

const signal = (pid: number, name: NodeJS.Signals): void => {
  try { process.kill(pid, name); } catch { /* Gone already. */ }
};

// Ends a process at once, and what it started. It may be stuck, so it gets no
// chance to tidy up; what it started is asked to end, as Stop asks.
export const endProcessTree = async (pid: number): Promise<void> => {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .once('error', () => { signal(pid, 'SIGKILL'); resolve(); })
        .once('exit', () => resolve());
    });
    return;
  }
  const started = descendantsOf(await processRows().catch((): Array<[number, number]> => []), pid);
  signal(pid, 'SIGKILL');
  started.forEach((child) => signal(child, 'SIGTERM'));
};
