import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { t, type TranslationKey } from './localization';
import { isMac, primaryKey } from './shortcuts';

// Keys the studio uses, which reach it instead of the shell, as in VS Code:
// Run, Debug and stepping, Save, Open, Build, the side bar, the panel and zoom.
const studioKey = (event: KeyboardEvent): boolean => {
  if (['F5', 'F6', 'F9', 'F10', 'F11'].includes(event.key)) return true;
  if (event.ctrlKey && event.code === 'Backquote') return true;
  return primaryKey(event) && !event.altKey && ['s', 'o', 'b', 'j', '+', '=', '-', '0'].includes(event.key.toLowerCase());
};

// The Terminal and Agent tabs: xterm.js showing a shell, or an agent, that the
// backend runs in the project folder (startTerminal in studio.ts).
export class StudioTerminal {
  private readonly terminal: Terminal;
  private readonly fit = new FitAddon();
  private opened = false;
  private running = false;
  private starting: Promise<void> | null = null;
  // Invalidates a startup when its project, agent, or requested folder changes.
  private context = 0;
  private fontSize = 12;
  private scale = 1;
  private directory?: string;
  // The agent the agent session runs.
  private agent?: GlistAgentId;

  constructor(
    private readonly host: HTMLElement,
    private readonly session: GlistTerminalSession,
    private readonly exitedMessage: TranslationKey = 'terminalExited',
    // Whether a key press after the program exits starts it again.
    private readonly restartOnKey = true,
  ) {
    this.terminal = new Terminal({ cursorBlink: true, scrollback: 5000 });
    this.terminal.loadAddon(this.fit);
    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.terminal.onData((data) => {
      if (this.running) void window.glistAPI.writeTerminal(this.session, data);
      else if (this.restartOnKey) void this.start();
    });
    this.terminal.onResize(({ cols, rows }) => {
      if (this.running) void window.glistAPI.resizeTerminal(this.session, cols, rows);
    });
    window.glistAPI.onTerminalData(({ session, data }) => { if (session === this.session) this.terminal.write(data); });
    window.glistAPI.onTerminalExit(({ session, exitCode }) => {
      if (session !== this.session) return;
      this.running = false;
      if (this.restartOnKey) this.terminal.write(`\r\n\x1b[2m${t(this.exitedMessage)} ${exitCode}. ${t('terminalRestartHint')}\x1b[0m\r\n`);
    });
    new ResizeObserver(() => this.fitToHost()).observe(host);
  }

  // Shows the terminal, with a shell the first time.
  show(): void {
    if (!this.opened) {
      this.terminal.open(this.host);
      this.opened = true;
    }
    this.fitToHost();
    if (!this.running && this.restartOnKey) void this.start();
    this.terminal.focus();
  }

  // Opens a fresh shell at an Explorer entry: inside a folder, or beside a file.
  async openAt(entryPath: string): Promise<void> {
    const context = this.context;
    // If the terminal was just shown, let that startup finish before replacing it.
    if (this.starting) await this.starting;
    // The project may have changed while that startup was finishing.
    if (context !== this.context) return;
    if (!this.opened) {
      this.terminal.open(this.host);
      this.opened = true;
    }
    this.fitToHost();
    this.running = false;
    this.terminal.reset();
    this.terminal.focus();
    this.directory = entryPath;
    this.context += 1;
    await this.start(entryPath);
  }

  // Starts the program afresh, for a terminal that does not start on its own.
  run(): Promise<void> {
    this.show();
    this.terminal.reset();
    return this.start();
  }

  // Ends the shell and starts a new one in the same working directory.
  async restart(): Promise<void> {
    this.running = false;
    this.terminal.reset();
    this.terminal.focus();
    await this.start();
  }

  // A shell that was started keeps up with the open project.
  projectChanged(): void {
    const active = this.running || Boolean(this.starting);
    const context = ++this.context;
    this.directory = undefined;
    if (active) void this.restartAfterStarting(context);
  }

  // Runs another agent; a running one is ended first.
  setAgent(agent: GlistAgentId | undefined): void {
    if (agent === this.agent) return;
    const active = this.running || Boolean(this.starting);
    const context = ++this.context;
    this.agent = agent;
    if (active) void this.restartAfterStarting(context);
  }

  stop(): void {
    this.context += 1;
    this.running = false;
    void window.glistAPI.stopTerminal(this.session);
  }

  clear(): void {
    this.terminal.clear();
    this.terminal.focus();
  }

  setTheme(theme: ITheme): void {
    this.terminal.options.theme = theme;
  }

  setFont(family: string, size: number): void {
    this.terminal.options.fontFamily = family;
    this.fontSize = size;
    this.setScale(this.scale);
  }

  // The browser build's page zoom, which the terminal shows as a larger font.
  setScale(scale: number): void {
    this.scale = scale;
    this.terminal.options.fontSize = Math.round(this.fontSize * scale * 10) / 10;
    this.fitToHost();
  }

  private async start(directory = this.directory): Promise<void> {
    if (this.starting) return this.starting;
    const context = this.context;
    const startup = (async () => {
      const result = await window.glistAPI.startTerminal(
        this.session, this.terminal.cols, this.terminal.rows, directory, this.agent,
      );
      if (context !== this.context) {
        if (result.success) await window.glistAPI.stopTerminal(this.session);
        return;
      }
      this.running = result.success;
      if (!result.success) this.terminal.write(`\x1b[31m${result.message}\x1b[0m\r\n`);
    })();
    const tracked = startup.finally(() => { if (this.starting === tracked) this.starting = null; });
    this.starting = tracked;
    return tracked;
  }

  // A context change during an IPC startup waits for it to be cancelled, then
  // starts exactly once with the latest project, folder, and agent.
  private async restartAfterStarting(context: number): Promise<void> {
    if (this.starting) await this.starting.catch((): undefined => undefined);
    if (context !== this.context) return;
    this.running = false;
    this.terminal.reset();
    this.terminal.focus();
    await this.start();
  }

  // Fits the terminal to its panel, which has no size while hidden.
  private fitToHost(): void {
    if (this.opened && this.host.clientWidth > 0 && this.host.clientHeight > 0) this.fit.fit();
  }

  // Returning false leaves a key to the browser and the studio instead of the shell.
  private handleKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    if (studioKey(event)) return false;
    // Copy and paste as in other programs. A Mac has Cmd for them, which the
    // shell never sees; elsewhere Ctrl+C copies a selection and otherwise
    // interrupts, and Ctrl+V pastes.
    if (!isMac && event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'c' && this.terminal.hasSelection()) {
        void navigator.clipboard.writeText(this.terminal.getSelection());
        this.terminal.clearSelection();
        return false;
      }
      if (key === 'v' || (key === 'c' && event.shiftKey)) return false;
    }
    return true;
  }
}
