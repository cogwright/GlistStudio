import { getLanguage, t } from './localization';
import { newOutputStyle, type OutputStyle } from './output-format';

// The Output tab's builds, runs and debug sessions, each with what it printed,
// in a section of its own inside the output. The list beside the tab's tools
// shows one of them again, with when it started and how it ended. With
// Settings > Build's Clear Output on, each new one shows by itself; with it
// off, the output runs on as one log, and the list can still pick one out.
export type OutputRunKind = 'build' | 'cleanBuild' | 'run' | 'debug';
export type OutputRunState = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface OutputSection {
  readonly element: HTMLElement;
  style: OutputStyle;
}

export interface OutputRun extends OutputSection {
  readonly id: number;
  readonly kind: OutputRunKind;
  readonly started: number;
  state: OutputRunState;
  exitCode?: number;
  // Stop was pressed while it ran, so it ended because of that.
  stopRequested: boolean;
}

// Build logs are large; older ones go.
const keptRuns = 20;
const marks: Record<OutputRunState, string> = { running: '●', succeeded: '✓', failed: '✕', stopped: '■' };

export class OutputHistory {
  // Oldest first.
  private runs: OutputRun[] = [];
  private base: OutputSection;
  private shown: number | 'all' = 'all';
  private nextId = 1;
  current: OutputSection;

  constructor(
    private readonly output: HTMLElement,
    private readonly list: HTMLSelectElement,
    private readonly clearsOnRun: () => boolean,
    // How many runs there are now, for showing the list or not.
    private readonly changed: (size: number) => void,
  ) {
    this.reset(output.textContent ?? '');
    list.addEventListener('change', () => {
      this.shown = list.value === 'all' ? 'all' : Number(list.value);
      this.apply();
      this.output.scrollTop = this.output.scrollHeight;
    });
  }

  get size(): number {
    return this.runs.length;
  }

  // Empties the output, and forgets every run: for a project opened, and Clear Output.
  reset(text = ''): void {
    this.runs = [];
    this.base = this.section('output-base');
    this.output.replaceChildren(this.base.element);
    if (text) this.base.element.textContent = text;
    this.current = this.base;
    this.shown = 'all';
    this.render();
  }

  // A build, run or debug session starting; what is printed goes to it from now on.
  begin(kind: OutputRunKind): OutputRun {
    const run: OutputRun = {
      ...this.section('output-run'), id: this.nextId++, kind, started: Date.now(), state: 'running', stopRequested: false,
    };
    this.output.append(run.element);
    this.runs.push(run);
    this.runs.splice(0, Math.max(0, this.runs.length - keptRuns)).forEach((old) => old.element.remove());
    this.current = run;
    this.shown = this.clearsOnRun() ? run.id : 'all';
    this.render();
    return run;
  }

  finish(run: OutputRun, state: Exclude<OutputRunState, 'running'>, exitCode?: number): void {
    if (run.state !== 'running') return;
    run.state = state;
    run.exitCode = exitCode;
    this.render();
  }

  // An exit code ends a run well or not; no code, a run that was stopped or killed.
  finishWithExit(run: OutputRun, exitCode: number | undefined): void {
    if (exitCode !== undefined) this.finish(run, exitCode === 0 ? 'succeeded' : 'failed', exitCode);
    else this.finish(run, run.stopRequested ? 'stopped' : 'failed');
  }

  running(): OutputRun[] {
    return this.runs.filter((run) => run.state === 'running');
  }

  isShown(section: OutputSection): boolean {
    return !section.element.hidden;
  }

  // The setting changed: off, everything shows again as one log.
  modeChanged(): void {
    const latest = this.runs[this.runs.length - 1];
    this.shown = this.clearsOnRun() && latest ? latest.id : 'all';
    this.render();
  }

  // The list in the interface language, as after a language change.
  render(): void {
    const options = [...this.runs].reverse().map((run) => new Option(this.label(run), String(run.id)));
    if (!this.clearsOnRun() && this.runs.length) options.unshift(new Option(t('outputAll'), 'all'));
    this.list.replaceChildren(...options);
    this.list.value = String(this.shown);
    this.apply();
    this.changed(this.runs.length);
  }

  private apply(): void {
    this.base.element.hidden = this.shown !== 'all';
    this.runs.forEach((run) => { run.element.hidden = this.shown !== 'all' && this.shown !== run.id; });
  }

  private label(run: OutputRun): string {
    const time = new Date(run.started).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const state = run.exitCode !== undefined ? t('runExitCode').replace('{code}', String(run.exitCode))
      : t(({ running: 'runRunning', succeeded: 'runSucceeded', failed: 'runFailed', stopped: 'runStopped' } as const)[run.state]);
    return `${marks[run.state]} ${t(run.kind)} · ${time} · ${state}`;
  }

  private section(className: string): OutputSection {
    const element = document.createElement('div');
    element.className = className;
    return { element, style: newOutputStyle() };
  }
}
