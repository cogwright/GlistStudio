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
  // The newest block of lines, and whether its last line ended; characters shown.
  tail: HTMLElement | null;
  ended: boolean;
  size: number;
}

// What a section shows at most; past it, its oldest lines go, to four fifths of it.
const keptCharacters = 1_000_000;

// Removes a section's oldest blocks, with a line at its top that says so.
const trim = (section: OutputSection): void => {
  let marker = section.element.firstElementChild;
  if (!marker?.classList.contains('output-trimmed')) {
    marker = document.createElement('div');
    marker.className = 'output-trimmed';
    (marker as HTMLElement).dataset.i18n = 'outputTrimmed';
    marker.textContent = t('outputTrimmed');
    section.element.prepend(marker);
  }
  while (section.size > keptCharacters * 0.8 && marker.nextSibling) {
    const oldest = marker.nextSibling;
    section.size -= oldest.textContent?.length ?? 0;
    if (oldest === section.tail) section.tail = null;
    oldest.remove();
  }
};

// Adds to what a section shows. Lines go into blocks, a new one once the last
// ended its line, so the page lays out only the new lines rather than every
// line before them again: as one run of text, a game's log took 105 ms a frame
// to add to at 10 MB, and 3 ms in blocks.
export const appendToSection = (section: OutputSection, nodes: (Node | string)[]): void => {
  const text = nodes.map((node) => (typeof node === 'string' ? node : node.textContent ?? '')).join('');
  if (!text) return;
  let block = section.tail;
  if (!block || section.ended || block.parentNode !== section.element) {
    block = document.createElement('div');
    section.element.append(block);
    section.tail = block;
  }
  block.append(...nodes);
  section.ended = text.endsWith('\n');
  section.size += text.length;
  if (section.size > keptCharacters) trim(section);
};

// Adds printed text, made into nodes by format. Text that finishes the last
// line goes into that line's block, and the rest into one of its own: a batch
// often ends partway through a line, and without that, a program printing
// without a pause would make one block of everything.
export const appendTextToSection = (section: OutputSection, text: string, format: (text: string) => Node[]): void => {
  const lineEnd = section.tail && !section.ended ? text.indexOf('\n') : -1;
  if (lineEnd >= 0 && lineEnd < text.length - 1) {
    appendToSection(section, format(text.slice(0, lineEnd + 1)));
    appendToSection(section, format(text.slice(lineEnd + 1)));
  } else appendToSection(section, format(text));
};

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
    if (text) appendToSection(this.base, [text]);
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
    return { element, style: newOutputStyle(), tail: null, ended: false, size: 0 };
  }
}
