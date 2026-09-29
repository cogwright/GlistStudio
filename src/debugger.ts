// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { icon } from './icons';
import { t } from './localization';
import { baseName, pathUri, uriPath } from './paths';

export type DebugState = 'idle' | 'starting' | 'running' | 'paused';

export interface DebuggerHost {
  editor: monaco.editor.IStandaloneCodeEditor;
  // Opens a file in a tab and shows the line. False if it cannot be opened.
  openLocation(filePath: string, line: number): Promise<boolean>;
  log(text: string, kind?: 'normal' | 'success' | 'error'): void;
  // The session state changed; toolbars and menus follow.
  changed(): void;
  // There is no debugger, and Settings can install one.
  missingDebugger?(): void;
  views: { status: HTMLElement; variables: HTMLElement; stack: HTMLElement; breakpoints: HTMLElement };
}

interface Pending {
  resolve(body: unknown): void;
  reject(error: Error): void;
}

interface FileBreakpoints {
  path: string;
  lines: number[];
}

const storageKey = (projectRoot: string): string => `glist-studio-breakpoints:${projectRoot}`;

// Runs programs under a debug adapter (lldb-dap or GDB) through the glistAPI
// bridge, and shows breakpoints, the current line, variables and the call stack.
export class Debugger {
  state: DebugState = 'idle';
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventWaiters = new Map<string, Array<() => void>>();
  private capabilities: DebugProtocol.Capabilities = {};
  private threadId = 0;
  private frames: DebugProtocol.StackFrame[] = [];
  private frame: DebugProtocol.StackFrame | null = null;
  private projectRoot: string | null = null;
  // Keyed by file URI, so one file has one entry however its path is spelled.
  private readonly breakpoints = new Map<string, FileBreakpoints>();
  private readonly verified = new Map<number, { uri: string; line: number }>();
  private readonly unverified = new Set<string>();
  private readonly decorations = new Map<string, string[]>();
  private current: { model: monaco.editor.ITextModel; ids: string[] } | null = null;
  private readonly hint: monaco.editor.IEditorDecorationsCollection;

  constructor(private readonly host: DebuggerHost) {
    window.glistAPI.onDebugMessage((message) => this.receive(message as DebugProtocol.ProtocolMessage));
    window.glistAPI.onDebugStatus((status) => {
      if (this.state === 'idle') return;
      if (status.message) host.log(`\n${status.message}\n`, 'error');
      this.finish();
    });
    monaco.editor.onDidCreateModel((model) => this.decorate(model));
    this.hint = host.editor.createDecorationsCollection();
    const { MouseTargetType } = monaco.editor;
    host.editor.onMouseDown((event) => {
      const model = host.editor.getModel();
      if (model && event.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
        this.toggle(model, event.target.position.lineNumber);
      }
    });
    // A faint dot where a click in the margin would put a breakpoint.
    host.editor.onMouseMove((event) => {
      const line = event.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN ? event.target.position?.lineNumber : undefined;
      this.hint.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'debug-breakpoint-hint' } }] : []);
    });
    host.editor.onMouseLeave(() => this.hint.clear());
    monaco.languages.registerHoverProvider('cpp', {
      provideHover: async (model, position) => this.hover(model, position),
    });
    this.render();
  }

  get active(): boolean {
    return this.state !== 'idle';
  }

  // Breakpoints belong to a project and are kept between sessions.
  setProject(projectRoot: string | null): void {
    this.projectRoot = projectRoot;
    this.breakpoints.clear();
    if (projectRoot) {
      try {
        const saved = JSON.parse(window.localStorage.getItem(storageKey(projectRoot)) ?? '[]') as FileBreakpoints[];
        saved.forEach((file) => { if (file.path && file.lines?.length) this.breakpoints.set(pathUri(file.path).toString(), file); });
      } catch { /* Start without breakpoints. */ }
    }
    monaco.editor.getModels().forEach((model) => this.decorate(model));
    this.render();
  }

  toggleAtCursor(): void {
    const model = this.host.editor.getModel();
    const position = this.host.editor.getPosition();
    if (model && position) this.toggle(model, position.lineNumber);
  }

  toggle(model: monaco.editor.ITextModel, line: number): void {
    const uri = model.uri.toString();
    const file = this.breakpoints.get(uri) ?? { path: uriPath(model.uri), lines: [] };
    file.lines = file.lines.includes(line) ? file.lines.filter((other) => other !== line) : [...file.lines, line].sort((a, b) => a - b);
    this.update(uri, file);
    this.decorate(model);
  }

  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    this.setState('starting');
    const started = await window.glistAPI.startDebugging().catch((error: Error) => ({ success: false, message: error.message } as GlistDebugStart));
    if (!started.success || !started.program) {
      this.host.log(`\n${started.message}\n`, 'error');
      if (started.missingDebugger) this.host.missingDebugger?.();
      this.setState('idle');
      return;
    }
    try {
      // Adapters send 'initialized' after the initialize response or after launch; catch either.
      const initialized = this.nextEvent('initialized');
      this.capabilities = await this.request<DebugProtocol.Capabilities>('initialize', {
        clientID: 'glist-studio', clientName: 'Glist Studio', adapterID: started.flavor ?? 'lldb',
        pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true,
      }) ?? {};
      const launch = started.flavor === 'gdb'
        ? { program: started.program, cwd: started.cwd, args: [] as string[] }
        : { program: started.program, cwd: started.cwd, args: [] as string[], stopOnEntry: false };
      const launched = this.request('launch', launch);
      await initialized;
      for (const file of this.breakpoints.values()) await this.sendBreakpoints(file);
      if (this.capabilities.supportsConfigurationDoneRequest) await this.request('configurationDone', {});
      await launched;
      // An early stop at a breakpoint may already have changed the state.
      if ((this.state as DebugState) === 'starting') this.setState('running');
    } catch (error) {
      if (this.state !== 'idle') {
        this.host.log(`\n${t('debuggerFailed')}: ${error instanceof Error ? error.message : String(error)}\n`, 'error');
        await this.stop();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    const disconnected = this.request('disconnect', { terminateDebuggee: true }).catch((): undefined => undefined);
    await Promise.race([disconnected, new Promise((resolve) => setTimeout(resolve, 2000))]);
    this.finish();
  }

  continue(): void { this.control('continue'); }
  pause(): void { this.control('pause'); }
  stepOver(): void { this.control('next'); }
  stepInto(): void { this.control('stepIn'); }
  stepOut(): void { this.control('stepOut'); }

  private control(command: 'continue' | 'pause' | 'next' | 'stepIn' | 'stepOut'): void {
    const allowed = command === 'pause' ? this.state === 'running' : this.state === 'paused';
    if (!allowed) return;
    void this.request(command, { threadId: this.threadId }).catch((error: Error) => this.host.log(`\n${error.message}\n`, 'error'));
  }

  private setState(state: DebugState): void {
    this.state = state;
    this.render();
    this.host.changed();
  }

  // Ends the session on this side, whatever the adapter still does.
  private finish(): void {
    this.pending.forEach((request) => request.reject(new Error('Debugging stopped')));
    this.pending.clear();
    this.eventWaiters.clear();
    this.verified.clear();
    this.unverified.clear();
    this.frames = [];
    this.frame = null;
    this.clearCurrentLine();
    monaco.editor.getModels().forEach((model) => this.decorate(model));
    void window.glistAPI.stopDebugging();
    this.setState('idle');
  }

  private send(message: Omit<DebugProtocol.ProtocolMessage, 'seq'> & Record<string, unknown>): number {
    const seq = this.seq;
    this.seq += 1;
    void window.glistAPI.sendDebug({ ...message, seq });
    return seq;
  }

  private request<T = unknown>(command: string, args: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const seq = this.send({ type: 'request', command, arguments: args });
      this.pending.set(seq, { resolve: resolve as (body: unknown) => void, reject });
    });
  }

  private nextEvent(name: string): Promise<void> {
    return new Promise((resolve) => this.eventWaiters.set(name, [...(this.eventWaiters.get(name) ?? []), resolve]));
  }

  private receive(message: DebugProtocol.ProtocolMessage): void {
    if (message.type === 'response') {
      const response = message as DebugProtocol.Response;
      const request = this.pending.get(response.request_seq);
      this.pending.delete(response.request_seq);
      if (response.success) request?.resolve(response.body);
      else request?.reject(new Error(response.message ?? response.command));
    } else if (message.type === 'event') {
      const event = message as DebugProtocol.Event;
      this.eventWaiters.get(event.event)?.forEach((resolve) => resolve());
      this.eventWaiters.delete(event.event);
      void this.handleEvent(event);
    } else if (message.type === 'request') {
      // Nothing is advertised that would make the adapter ask us anything.
      const request = message as DebugProtocol.Request;
      this.send({ type: 'response', request_seq: request.seq, command: request.command, success: false, message: 'Not supported' });
    }
  }

  private async handleEvent(event: DebugProtocol.Event): Promise<void> {
    switch (event.event) {
      case 'stopped': {
        const body = (event as DebugProtocol.StoppedEvent).body;
        this.threadId = body.threadId ?? this.threadId;
        this.setState('paused');
        this.host.views.status.textContent = `${t('debugPaused')}: ${body.description ?? body.reason}`;
        await this.loadStack();
        break;
      }
      case 'continued':
        this.frames = [];
        this.frame = null;
        this.clearCurrentLine();
        this.setState('running');
        break;
      case 'output': {
        const { category, output } = (event as DebugProtocol.OutputEvent).body;
        if (category === 'stdout' || category === 'stderr' || category === 'important') this.host.log(output, 'normal');
        break;
      }
      case 'exited':
        this.host.log(`\n${t('programExited')} ${(event as DebugProtocol.ExitedEvent).body.exitCode}.\n`, 'normal');
        break;
      case 'terminated':
        this.finish();
        break;
      case 'breakpoint': {
        const { breakpoint } = (event as DebugProtocol.BreakpointEvent).body;
        const known = breakpoint.id === undefined ? undefined : this.verified.get(breakpoint.id);
        if (known) {
          const key = `${known.uri}:${known.line}`;
          if (breakpoint.verified) this.unverified.delete(key); else this.unverified.add(key);
          const model = monaco.editor.getModel(monaco.Uri.parse(known.uri));
          if (model) this.decorate(model);
        }
        break;
      }
      default:
        break;
    }
  }

  private async sendBreakpoints(file: FileBreakpoints): Promise<void> {
    if (this.state === 'idle') return;
    const uri = pathUri(file.path).toString();
    const result = await this.request<DebugProtocol.SetBreakpointsResponse['body']>('setBreakpoints', {
      source: { name: baseName(file.path), path: file.path },
      breakpoints: file.lines.map((line) => ({ line })),
    }).catch((): null => null);
    result?.breakpoints.forEach((breakpoint, index) => {
      const line = file.lines[index];
      if (breakpoint.id !== undefined) this.verified.set(breakpoint.id, { uri, line });
      if (breakpoint.verified) this.unverified.delete(`${uri}:${line}`); else this.unverified.add(`${uri}:${line}`);
    });
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) this.decorate(model);
  }

  private update(uri: string, file: FileBreakpoints): void {
    if (file.lines.length) this.breakpoints.set(uri, file); else this.breakpoints.delete(uri);
    if (this.projectRoot) {
      try {
        window.localStorage.setItem(storageKey(this.projectRoot), JSON.stringify([...this.breakpoints.values()]));
      } catch { /* Storage may be unavailable. */ }
    }
    void this.sendBreakpoints(file);
    this.render();
  }

  // Breakpoint dots on a model. They move with the text, and the stored lines follow them.
  private decorate(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    const lines = this.breakpoints.get(uri)?.lines ?? [];
    const ids = model.deltaDecorations(this.decorations.get(uri) ?? [], lines.map((line) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: this.unverified.has(`${uri}:${line}`) ? 'debug-breakpoint unverified' : 'debug-breakpoint',
        glyphMarginHoverMessage: { value: t('breakpoint') },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
    this.decorations.set(uri, ids);
    if (!model.isDisposed() && !trackedModels.has(model)) {
      trackedModels.add(model);
      model.onDidChangeContent(() => this.follow(model));
      model.onWillDispose(() => { trackedModels.delete(model); this.decorations.delete(model.uri.toString()); });
    }
  }

  private follow(model: monaco.editor.ITextModel): void {
    const uri = model.uri.toString();
    const file = this.breakpoints.get(uri);
    if (!file) return;
    const lines = [...new Set((this.decorations.get(uri) ?? [])
      .map((id) => model.getDecorationRange(id)?.startLineNumber)
      .filter((line): line is number => line !== undefined))].sort((a, b) => a - b);
    if (lines.join() === file.lines.join()) return;
    this.update(uri, { ...file, lines });
  }

  private clearCurrentLine(): void {
    if (this.current && !this.current.model.isDisposed()) this.current.model.deltaDecorations(this.current.ids, []);
    this.current = null;
  }

  private async loadStack(): Promise<void> {
    const body = await this.request<DebugProtocol.StackTraceResponse['body']>('stackTrace', { threadId: this.threadId, levels: 50 })
      .catch((): null => null);
    this.frames = body?.stackFrames ?? [];
    // The innermost frame with source, since system libraries have none.
    await this.selectFrame(this.frames.find((frame) => frame.source?.path) ?? this.frames[0] ?? null);
  }

  private async selectFrame(frame: DebugProtocol.StackFrame | null): Promise<void> {
    this.frame = frame;
    this.clearCurrentLine();
    const path = frame?.source?.path;
    if (frame && path && await this.host.openLocation(path, frame.line)) {
      const model = monaco.editor.getModel(pathUri(path));
      if (model) {
        this.current = {
          model,
          ids: model.deltaDecorations([], [{
            range: new monaco.Range(frame.line, 1, frame.line, 1),
            options: { isWholeLine: true, className: 'debug-current-line', glyphMarginClassName: 'debug-current-arrow' },
          }]),
        };
      }
    }
    this.render();
    await this.renderVariables();
  }

  private async hover(model: monaco.editor.ITextModel, position: monaco.Position): Promise<monaco.languages.Hover | null> {
    const word = model.getWordAtPosition(position);
    if (this.state !== 'paused' || !this.frame || !word) return null;
    const result = await this.request<DebugProtocol.EvaluateResponse['body']>('evaluate', {
      expression: word.word, frameId: this.frame.id, context: 'hover',
    }).catch((): null => null);
    if (!result) return null;
    return {
      range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
      contents: [{ value: `\`\`\`cpp\n${word.word} = ${result.result}\n\`\`\`` }],
    };
  }

  // The Debug view

  private render(): void {
    const { status, stack, breakpoints } = this.host.views;
    if (this.state !== 'paused') {
      status.textContent = t(({
        idle: 'debugIdle', starting: 'debugStarting', running: 'debugRunning', paused: 'debugPaused',
      } as const)[this.state]);
    }
    stack.replaceChildren(...this.frames.map((frame) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'debug-row';
      row.classList.toggle('active', frame === this.frame);
      row.classList.toggle('muted', !frame.source?.path);
      const name = document.createElement('span');
      name.className = 'debug-name';
      name.textContent = frame.name;
      const where = document.createElement('span');
      where.className = 'debug-detail';
      where.textContent = frame.source?.path ? `${baseName(frame.source.path)}:${frame.line}` : '';
      row.append(name, where);
      row.addEventListener('click', () => { void this.selectFrame(frame); });
      return row;
    }));
    if (this.state !== 'paused') this.host.views.variables.replaceChildren();
    const rows = [...this.breakpoints.values()].flatMap((file) => file.lines.map((line) => {
      const row = document.createElement('div');
      row.className = 'debug-row';
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'debug-name';
      open.textContent = `${baseName(file.path)}:${line}`;
      open.title = file.path;
      open.addEventListener('click', () => { void this.host.openLocation(file.path, line); });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'debug-remove';
      remove.append(icon('close'));
      remove.title = t('removeBreakpoint');
      remove.addEventListener('click', () => {
        const uri = pathUri(file.path).toString();
        this.update(uri, { ...file, lines: file.lines.filter((other) => other !== line) });
        const model = monaco.editor.getModel(pathUri(file.path));
        if (model) this.decorate(model);
      });
      row.append(open, remove);
      return row;
    }));
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'debug-empty';
      empty.textContent = t('noBreakpoints');
      rows.push(empty);
    }
    breakpoints.replaceChildren(...rows);
  }

  private async renderVariables(): Promise<void> {
    const host = this.host.views.variables;
    const frame = this.frame;
    if (!frame) { host.replaceChildren(); return; }
    const body = await this.request<DebugProtocol.ScopesResponse['body']>('scopes', { frameId: frame.id }).catch((): null => null);
    if (frame !== this.frame) return;
    // Registers mean nothing to most people who press Debug.
    const scopes = (body?.scopes ?? []).filter((scope) => scope.presentationHint !== 'registers' && scope.name !== 'Registers');
    host.replaceChildren(...scopes.map((scope, index) => this.variableNode(scope.name, '', '', scope.variablesReference, 0, index === 0)));
  }

  private variableNode(name: string, value: string, type: string, reference: number, depth: number, open = false): HTMLElement {
    const node = document.createElement('div');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'debug-variable';
    row.style.paddingLeft = `${6 + depth * 12}px`;
    row.title = type;
    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    if (reference) arrow.append(icon('chevron-right'));
    const label = document.createElement('span');
    label.className = 'debug-name';
    label.textContent = name;
    const shown = document.createElement('span');
    shown.className = 'debug-value';
    shown.textContent = value;
    row.append(arrow, label, shown);
    const children = document.createElement('div');
    children.hidden = true;
    node.append(row, children);
    let loaded = false;
    const expand = async (): Promise<void> => {
      children.hidden = !children.hidden;
      arrow.classList.toggle('expanded', !children.hidden);
      if (loaded || children.hidden) return;
      loaded = true;
      const body = await this.request<DebugProtocol.VariablesResponse['body']>('variables', { variablesReference: reference }).catch((): null => null);
      children.replaceChildren(...(body?.variables ?? []).map((variable) =>
        this.variableNode(variable.name, variable.value, variable.type ?? '', variable.variablesReference, depth + 1)));
    };
    if (reference) row.addEventListener('click', () => { void expand(); });
    if (open && reference) void expand();
    return node;
  }
}

// Models whose edits already move their breakpoints.
const trackedModels = new WeakSet<monaco.editor.ITextModel>();
