// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';
import { conflictBlocks, resolvedLines, type ConflictChoice } from './conflicts';
import type { GitClient } from './git-client';
import { icon } from './icons';
import { lineChanges, type LineChange } from './line-diff';
import { t } from './localization';
import { notify } from './notifications';
import { baseName } from './paths';
import { fullTime, shortDate } from './time';

// Git in the code editors: marks beside the line numbers for lines changed
// since the last commit, which show the lines as they were and can put them
// back; who last changed each line (Annotate with Git Blame); and buttons
// above conflict markers to keep one side or both. Each editor, one per side
// of the editor area, is attached and keeps its own marks; what is known of a
// file, such as its blame, is shared, so both sides show it.

export interface GitEditorHooks {
  // The file a model is the tab of, or null.
  pathOf(model: monaco.editor.ITextModel): string | null;
  // Engine and plugin files open read-only: their marks and blame show, but nothing edits them.
  readOnly(model: monaco.editor.ITextModel): boolean;
  openDiff(filePath: string): void;
  showCommit(hash: string, filePath: string): void;
  markResolved(filePath: string): void;
}

// The committed text of a file, for the head it was read at.
interface Committed {
  head: string | null;
  text: string | null;
}

const cssColor = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';

// One attached editor's marks, for the file it shows.
interface EditorMarks {
  editor: monaco.editor.ICodeEditor;
  markers: monaco.editor.IEditorDecorationsCollection;
  blameLines: monaco.editor.IEditorDecorationsCollection;
  conflictLines: monaco.editor.IEditorDecorationsCollection;
  changes: LineChange[];
  timer: number;
  blameTimer: number;
}

export class GitEditor {
  private readonly committed = new Map<string, Committed>();
  private readonly blames = new Map<string, GlistGitBlameLine[]>();
  private readonly attached: EditorMarks[] = [];
  private readonly popup = document.createElement('div');
  // The editor the popup shows a change of, and the last changed line it is shown under.
  private popupMarks: EditorMarks | null = null;
  private popupLine = 0;
  private readonly lensChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();

  constructor(
    // The editor worked in, for Annotate from a menu.
    private readonly currentEditor: () => monaco.editor.ICodeEditor,
    private readonly client: GitClient,
    private readonly hooks: GitEditorHooks,
  ) {
    this.popup.className = 'git-change-popup';
    this.popup.hidden = true;
    document.body.append(this.popup);
    document.addEventListener('pointerdown', (event) => {
      if (!this.popup.hidden && !this.popup.contains(event.target as Node)) this.hidePopup();
    });
    // Before the editor, which keeps Escape to itself.
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') this.hidePopup(); }, true);
    client.onStatus(() => { this.attached.forEach((marks) => { void this.update(marks); }); });
    client.onEnabled((enabled) => {
      if (!enabled) { this.blames.clear(); this.attached.forEach((marks) => this.showBlame(marks)); }
      this.lensChanged.fire(this.lenses);
    });
    this.registerConflictLenses();
  }

  // Marks an editor, from now on, as it shows one file and then another.
  attach(editor: monaco.editor.ICodeEditor): void {
    const marks: EditorMarks = {
      editor,
      markers: editor.createDecorationsCollection(),
      blameLines: editor.createDecorationsCollection(),
      conflictLines: editor.createDecorationsCollection(),
      changes: [],
      timer: 0,
      blameTimer: 0,
    };
    this.attached.push(marks);
    editor.onDidChangeModel(() => { this.hidePopup(marks); this.showBlame(marks); void this.update(marks); });
    editor.onDidChangeModelContent(() => {
      this.hidePopup(marks);
      window.clearTimeout(marks.timer);
      marks.timer = window.setTimeout(() => { void this.update(marks); }, 200);
      if (this.blames.has(this.path(marks) ?? '')) {
        window.clearTimeout(marks.blameTimer);
        marks.blameTimer = window.setTimeout(() => { void this.loadBlame(marks); }, 800);
      }
    });
    editor.onDidScrollChange(() => { if (!this.popup.hidden && this.popupMarks === marks) this.placePopup(); });
    editor.onMouseDown((event) => {
      const target = event.target;
      if (target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
        && (target.element as HTMLElement | null)?.classList.contains('git-gutter') && target.position) {
        this.showPopup(marks, target.position.lineNumber);
      } else if (target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && target.position) {
        const filePath = this.path(marks);
        const line = filePath ? this.blames.get(filePath)?.[target.position.lineNumber - 1] : undefined;
        if (filePath && line && !line.uncommitted) this.hooks.showCommit(line.commit, filePath);
      }
    });
    void this.update(marks);
  }

  private path(marks: EditorMarks): string | null {
    const model = marks.editor.getModel();
    return model ? this.hooks.pathOf(model) : null;
  }

  // The marks follow the file as it is typed, against its last commit.
  private async update(marks: EditorMarks): Promise<void> {
    const model = marks.editor.getModel();
    const filePath = this.path(marks);
    const repository = filePath ? this.client.repositoryOf(filePath) : null;
    if (!model || !filePath || !repository || this.client.isIgnored(filePath)) {
      marks.changes = [];
      marks.markers.clear();
      marks.conflictLines.clear();
      return;
    }
    const state = this.client.changeOf(filePath)?.state;
    let committed = this.committed.get(filePath);
    if (!committed || committed.head !== repository.head) {
      let text: string | null = null;
      if (repository.head && state !== 'untracked' && state !== 'added') {
        try { text = (await window.glistAPI.gitFileAt('HEAD', filePath)).text; } catch { text = null; }
      }
      committed = { head: repository.head, text };
      this.committed.set(filePath, committed);
      if (marks.editor.getModel() !== model) return;
    }
    marks.changes = committed.text === null ? [] : lineChanges(committed.text, model.getValue());
    this.showMarkers(marks, model);
    this.showConflicts(marks, model);
  }

  private showMarkers(marks: EditorMarks, model: monaco.editor.ITextModel): void {
    const colors = { added: cssColor('--ansi-green'), modified: cssColor('--ansi-blue'), deleted: cssColor('--ansi-red') };
    const lastLine = model.getLineCount();
    marks.markers.set(marks.changes.map((change) => {
      const kind = change.originalCount === 0 ? 'added' : change.modifiedCount === 0 ? 'deleted' : 'modified';
      const range = kind === 'deleted'
        ? new monaco.Range(Math.max(1, Math.min(lastLine, change.modifiedStart - 1)), 1, Math.max(1, Math.min(lastLine, change.modifiedStart - 1)), 1)
        : new monaco.Range(change.modifiedStart, 1, change.modifiedStart + change.modifiedCount - 1, 1);
      const top = kind === 'deleted' && change.modifiedStart === 1;
      return {
        range,
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `git-gutter ${kind}${top ? ' top' : ''}`,
          overviewRuler: { color: colors[kind], position: monaco.editor.OverviewRulerLane.Left },
          minimap: { color: colors[kind], position: monaco.editor.MinimapPosition.Gutter },
        },
      };
    }));
  }

  private changeAt(marks: EditorMarks, line: number): LineChange | undefined {
    return marks.changes.find((change) => (change.modifiedCount === 0
      ? line === Math.max(1, change.modifiedStart - 1)
      : line >= change.modifiedStart && line < change.modifiedStart + change.modifiedCount));
  }

  // Like JetBrains' change popup: the lines as the last commit had them, with
  // the way to put them back, and to step to the other changes.
  private showPopup(marks: EditorMarks, line: number): void {
    const model = marks.editor.getModel();
    const change = this.changeAt(marks, line);
    const filePath = this.path(marks);
    const committed = filePath ? this.committed.get(filePath)?.text : null;
    if (!model || !change || committed === null || committed === undefined || !filePath) return;
    const index = marks.changes.indexOf(change);
    const before = committed.split(/\r?\n/).slice(change.originalStart - 1, change.originalStart - 1 + change.originalCount);
    const button = (name: Parameters<typeof icon>[0], title: string, run: () => void, disabled = false): HTMLButtonElement => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'heading-action';
      element.title = title;
      element.setAttribute('aria-label', title);
      element.disabled = disabled;
      element.append(icon(name));
      element.addEventListener('click', run);
      return element;
    };
    const toolbar = document.createElement('div');
    toolbar.className = 'git-change-toolbar';
    const label = document.createElement('span');
    label.textContent = change.originalCount === 0 ? t('linesAdded') : t('linesBefore');
    const step = (offset: number): void => {
      const next = marks.changes[index + offset];
      if (!next) return;
      const target = Math.max(1, next.modifiedCount === 0 ? next.modifiedStart - 1 : next.modifiedStart);
      marks.editor.revealLineInCenterIfOutsideViewport(target);
      marks.editor.setPosition({ lineNumber: target, column: 1 });
      window.requestAnimationFrame(() => this.showPopup(marks, target));
    };
    toolbar.append(
      label,
      button('arrow-up', t('previousChange'), () => step(-1), index === 0),
      button('arrow-down', t('nextChange'), () => step(1), index === marks.changes.length - 1),
      ...(this.hooks.readOnly(model) ? [] : [button('discard', t('rollbackChange'), () => { this.rollback(marks, model, change, before); this.hidePopup(); })]),
      button('diff', t('showDiff'), () => { this.hidePopup(); this.hooks.openDiff(filePath); }),
      button('close', t('close'), () => this.hidePopup()),
    );
    const nodes: HTMLElement[] = [toolbar];
    if (change.originalCount > 0) {
      const code = document.createElement('pre');
      code.className = 'git-change-before';
      code.textContent = before.join('\n');
      nodes.push(code);
    }
    this.popup.replaceChildren(...nodes);
    this.popupMarks = marks;
    this.popupLine = change.modifiedCount === 0 ? line : change.modifiedStart + change.modifiedCount - 1;
    this.popup.hidden = false;
    this.placePopup();
  }

  // Under the change, or above it near the bottom; it follows the change as the editor scrolls.
  private placePopup(): void {
    const editor = this.popupMarks?.editor;
    const zoom = Number(document.documentElement.style.getPropertyValue('--page-zoom')) || 1;
    const bounds = editor?.getDomNode()?.getBoundingClientRect();
    const position = editor?.getScrolledVisiblePosition({ lineNumber: this.popupLine, column: 1 });
    const layout = editor?.getLayoutInfo();
    if (!bounds || !position || !layout || position.top < 0 || position.top > layout.height) { this.hidePopup(); return; }
    this.popup.style.left = `${bounds.left / zoom + layout.decorationsLeft}px`;
    this.popup.style.width = `${Math.max(320, Math.min(760, layout.width - layout.decorationsLeft - 30))}px`;
    const below = bounds.top / zoom + position.top + position.height + 2;
    const height = this.popup.offsetHeight;
    this.popup.style.top = `${below + height > window.innerHeight / zoom ? Math.max(0, bounds.top / zoom + position.top - height - 2) : below}px`;
  }

  // Hides the popup, or only the one of the editor given.
  private hidePopup(marks?: EditorMarks): void {
    if (marks && this.popupMarks !== marks) return;
    this.popup.hidden = true;
    this.popupMarks = null;
  }

  // Puts the committed lines back in place of the changed ones, as one edit that Undo takes back.
  private rollback(marks: EditorMarks, model: monaco.editor.ITextModel, change: LineChange, before: string[]): void {
    const eol = model.getEOL();
    const lines = model.getLineCount();
    const start = change.modifiedStart;
    const end = start + change.modifiedCount - 1;
    let range: monaco.Range;
    let text: string;
    if (change.modifiedCount > 0 && change.originalCount > 0) {
      range = new monaco.Range(start, 1, end, model.getLineMaxColumn(end));
      text = before.join(eol);
    } else if (change.modifiedCount > 0) {
      // Added lines go, with the line break that joined them to the rest.
      range = end < lines ? new monaco.Range(start, 1, end + 1, 1)
        : start > 1 ? new monaco.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end))
          : new monaco.Range(1, 1, end, model.getLineMaxColumn(end));
      text = '';
    } else if (start <= lines) {
      range = new monaco.Range(start, 1, start, 1);
      text = before.join(eol) + eol;
    } else {
      range = new monaco.Range(lines, model.getLineMaxColumn(lines), lines, model.getLineMaxColumn(lines));
      text = eol + before.join(eol);
    }
    marks.editor.pushUndoStop();
    marks.editor.executeEdits('git-rollback', [{ range, text, forceMoveMarkers: true }]);
    marks.editor.pushUndoStop();
  }

  // The marks of the editor worked in.
  private current(): EditorMarks | undefined {
    const editor = this.currentEditor();
    return this.attached.find((marks) => marks.editor === editor);
  }

  isBlaming(): boolean {
    const marks = this.current();
    return Boolean(marks && this.blames.has(this.path(marks) ?? ''));
  }

  // For the file in the editor worked in, and every editor showing it.
  async toggleBlame(): Promise<void> {
    const marks = this.current();
    const filePath = marks && this.path(marks);
    if (!marks || !filePath) return;
    if (this.blames.has(filePath)) {
      this.blames.delete(filePath);
      this.showBlameOf(filePath);
      return;
    }
    await this.loadBlame(marks);
  }

  private async loadBlame(marks: EditorMarks): Promise<void> {
    const model = marks.editor.getModel();
    const filePath = this.path(marks);
    if (!model || !filePath) return;
    let lines: GlistGitBlameLine[] = [];
    try { lines = await window.glistAPI.gitBlame(filePath, model.getValue()); } catch { lines = []; }
    if (lines.length === 0 || lines.every((line) => line.uncommitted)) {
      notify({ text: t('blameUnavailable') });
      this.blames.delete(filePath);
    } else this.blames.set(filePath, lines);
    this.showBlameOf(filePath);
  }

  private showBlameOf(filePath: string): void {
    this.attached.filter((marks) => this.path(marks) === filePath).forEach((marks) => this.showBlame(marks));
  }

  // Who last changed each line and when, beside its number, as JetBrains shows
  // it; hovering a number tells the rest.
  private showBlame(marks: EditorMarks): void {
    const lines = this.blames.get(this.path(marks) ?? '');
    if (!lines) {
      marks.blameLines.clear();
      marks.editor.updateOptions({ lineNumbers: 'on', lineNumbersMinChars: 5 });
      return;
    }
    const recent = Date.now() / 1000 - 14 * 24 * 3600;
    const author = (line: GlistGitBlameLine): string => (line.uncommitted ? t('notCommittedYet') : line.author);
    const labels = lines.map((line) => `${line.uncommitted ? '' : shortDate(line.date * 1000)} ${author(line)}`.trim().slice(0, 26));
    marks.editor.updateOptions({
      lineNumbers: (number) => `${(labels[number - 1] ?? '').padEnd(27)}${String(number).padStart(4)}`,
      lineNumbersMinChars: 32,
    });
    marks.blameLines.set(lines.map((line, index) => ({
      range: new monaco.Range(index + 1, 1, index + 1, 1),
      options: {
        lineNumberClassName: line.uncommitted ? 'git-blame-new' : line.date > recent ? 'git-blame-recent' : 'git-blame',
        lineNumberHoverMessage: line.uncommitted ? { value: t('notCommittedYet') } : {
          value: `**${line.summary.replace(/[\\`*_[\]<>]/g, '\\$&')}**\n\n${line.author.replace(/[\\`*_[\]<>]/g, '\\$&')}, ${fullTime(line.date * 1000)}\n\n\`${line.commit.slice(0, 10)}\` ${t('blameClick')}`,
        },
      },
    })));
  }

  // Colors for both sides of each conflict, as the file is edited.
  private showConflicts(marks: EditorMarks, model: monaco.editor.ITextModel): void {
    const filePath = this.path(marks);
    if (!filePath || this.client.changeOf(filePath)?.state !== 'conflict') { marks.conflictLines.clear(); return; }
    const blocks = conflictBlocks(model.getLinesContent());
    const decoration = (from: number, to: number, className: string, label?: string): monaco.editor.IModelDeltaDecoration[] => (to < from ? []
      : [{ range: new monaco.Range(from, 1, to, 1), options: { isWholeLine: true, className } },
        // Whose side a marker line starts or ends, in words, after the marker's own text:
        // text at an empty range is not drawn, so the label spans the line.
        ...(label ? [{
          range: new monaco.Range(from, 1, from, model.getLineMaxColumn(from)),
          options: { after: { content: `  ${label}`, inlineClassName: 'git-conflict-label' } },
        }] : [])]);
    const [upper, lower] = this.mineIsUpper(filePath) ? ['mine', 'theirs'] as const : ['theirs', 'mine'] as const;
    marks.conflictLines.set(blocks.flatMap((block) => [
      ...decoration(block.start, block.start, `git-conflict-marker ${upper}`, t(upper)),
      ...decoration(block.start + 1, (block.base ?? block.separator) - 1, `git-conflict-${upper}`),
      ...decoration(block.base ?? block.separator, block.separator, 'git-conflict-marker'),
      ...decoration(block.separator + 1, block.end - 1, `git-conflict-${lower}`),
      ...decoration(block.end, block.end, `git-conflict-marker ${lower}`, t(lower)),
    ]));
  }

  private lenses: monaco.languages.CodeLensProvider = { provideCodeLenses: () => ({ lenses: [], dispose: () => undefined }) };

  // Which part of a conflict is the person's own: above the ======= line in a
  // merge, cherry-pick, revert or patch applied, and below it in a rebase or a stash brought back,
  // by what the file's own repository is doing: the project's, the engine's or a plugin's.
  private mineIsUpper(filePath: string): boolean {
    const operation = this.client.repositoryOf(filePath)?.operation;
    return operation === 'merge' || operation === 'cherry-pick' || operation === 'revert' || operation === 'am';
  }

  private registerConflictLenses(): void {
    const command = 'glist.git.resolveConflict';
    monaco.editor.registerCommand(command, (_accessor, uri: monaco.Uri, start: number, choice: 'mine' | 'theirs' | 'both') => {
      const model = monaco.editor.getModel(uri);
      if (!model) return;
      const lines = model.getLinesContent();
      const block = conflictBlocks(lines).find((entry) => entry.start === start);
      if (!block) return;
      const filePath = this.hooks.pathOf(model);
      if (!filePath) return;
      const part: ConflictChoice = choice === 'both' ? 'both' : (choice === 'mine') === this.mineIsUpper(filePath) ? 'upper' : 'lower';
      const replacement = resolvedLines(lines, block, part);
      const last = (line: number): number => model.getLineMaxColumn(line);
      // A part that is empty takes its line break with it.
      const range = replacement.length > 0 ? new monaco.Range(block.start, 1, block.end, last(block.end))
        : block.end < lines.length ? new monaco.Range(block.start, 1, block.end + 1, 1)
          : block.start > 1 ? new monaco.Range(block.start - 1, last(block.start - 1), block.end, last(block.end))
            : new monaco.Range(1, 1, block.end, last(block.end));
      model.pushStackElement();
      model.pushEditOperations([], [{ range, text: replacement.join(model.getEOL()) }], () => null);
      model.pushStackElement();
      if (conflictBlocks(model.getLinesContent()).length === 0) {
        notify({
          text: t('conflictsResolvedIn').replace('{name}', baseName(filePath)),
          actions: [{ label: t('markResolved'), run: () => this.hooks.markResolved(filePath) }],
        });
      }
    });
    this.lenses = {
      onDidChange: this.lensChanged.event,
      provideCodeLenses: (model) => {
        const filePath = this.hooks.pathOf(model);
        if (!this.client.enabled || !filePath || this.hooks.readOnly(model) || this.client.changeOf(filePath)?.state !== 'conflict') {
          return { lenses: [], dispose: () => undefined };
        }
        const lenses = conflictBlocks(model.getLinesContent()).flatMap((block) => (['mine', 'theirs', 'both'] as const).map((choice) => ({
          range: new monaco.Range(block.start, 1, block.start, 1),
          command: {
            id: command,
            title: t(choice === 'mine' ? 'keepMine' : choice === 'theirs' ? 'takeTheirs' : 'keepBoth'),
            arguments: [model.uri, block.start, choice],
          },
        })));
        return { lenses, dispose: () => undefined };
      },
    };
    monaco.languages.registerCodeLensProvider('*', this.lenses);
    this.client.onStatus(() => this.lensChanged.fire(this.lenses));
  }
}
