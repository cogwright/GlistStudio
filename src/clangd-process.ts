import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface ClangdLaunch {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const headerEnd = Buffer.from('\r\n\r\n');
const stderrLines = 20;

// Runs clangd and moves LSP messages across its stdio. The protocol itself is
// spoken by the renderer; this side only frames and unframes JSON.
export class ClangdProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = Buffer.alloc(0);
  private stderr: string[] = [];

  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onExit: (status: GlistClangdStatus) => void,
  ) {}

  start(launch: ClangdLaunch): Promise<GlistClangdStatus> {
    this.stop();
    const child = spawn('clangd', launch.args, { cwd: launch.cwd, env: launch.env, windowsHide: true });
    this.child = child;
    this.pending = Buffer.alloc(0);
    this.stderr = [];
    return new Promise((resolve) => {
      let started = false;
      child.once('spawn', () => { started = true; resolve({ running: true, message: '' }); });
      child.once('error', (error) => {
        if (this.child !== child) return;
        this.child = null;
        if (started) this.onExit({ running: false, message: error.message });
        else resolve({ running: false, message: error.message });
      });
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null;
        const detail = this.stderr.length > 0 ? `\n${this.stderr.join('\n')}` : '';
        this.onExit({ running: false, message: `clangd exited (${signal ?? code})${detail}` });
      });
      child.stdin.on('error', () => { /* Reported through 'exit'. */ });
      child.stdout.on('data', (chunk: Buffer) => { if (this.child === child) this.receive(chunk); });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
        this.stderr.splice(0, Math.max(0, this.stderr.length - stderrLines));
      });
    });
  }

  send(message: unknown): void {
    if (!this.child) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  private receive(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const end = this.pending.indexOf(headerEnd);
      if (end < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.pending.subarray(0, end).toString('ascii'))?.[1]);
      const start = end + headerEnd.length;
      if (!Number.isFinite(length)) { this.pending = this.pending.subarray(start); continue; }
      if (this.pending.length < start + length) return;
      const body = this.pending.subarray(start, start + length).toString('utf8');
      this.pending = this.pending.subarray(start + length);
      let message: unknown;
      try { message = JSON.parse(body); } catch { continue; }
      this.onMessage(message);
    }
  }
}
