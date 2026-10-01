// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';

// While the debugger is paused, pointing at a variable in an editor opens a
// small tree of its value beside it, as the Variables view shows it: a
// struct's members, a pointer's target and a list's items open out, and
// theirs too. It stays while the pointer is on the name or inside it, and
// goes on Escape, typing, scrolling or when the program goes on.

export interface PopupValue {
  // The text the value is for, 1-based columns, end-exclusive.
  range: monaco.IRange;
  content: HTMLElement;
}

let popups = 0;

export class ValuePopup implements monaco.editor.IContentWidget {
  readonly allowEditorOverflow = true;
  private readonly id = `glist.debugValue.${popups += 1}`;
  private readonly node = document.createElement('div');
  private position: monaco.IPosition | null = null;
  private range: monaco.Range | null = null;
  private showTimer = 0;
  private hideTimer = 0;
  // Each look is numbered, so an answer to an older one is dropped.
  private looks = 0;

  constructor(
    private readonly editor: monaco.editor.ICodeEditor,
    private readonly find: (model: monaco.editor.ITextModel, position: monaco.Position) => Promise<PopupValue | null>,
  ) {
    this.node.className = 'debug-value-popup';
    // The pointer in the popup keeps it, and stops looking at the text it crossed on the way.
    this.node.addEventListener('mouseenter', () => {
      window.clearTimeout(this.hideTimer);
      window.clearTimeout(this.showTimer);
      this.looks += 1;
    });
    this.node.addEventListener('mouseleave', () => this.hideSoon());
    // Its own scrolling, not the editor's.
    this.node.addEventListener('wheel', (event) => event.stopPropagation());
    new ResizeObserver(() => { if (this.position) editor.layoutContentWidget(this); }).observe(this.node);
    const { MouseTargetType } = monaco.editor;
    editor.onMouseMove((event) => {
      if (event.target.type === MouseTargetType.CONTENT_WIDGET && event.target.detail === this.id) return;
      const position = event.target.type === MouseTargetType.CONTENT_TEXT ? event.target.position : null;
      if (position && this.range?.containsPosition(position)) {
        window.clearTimeout(this.hideTimer);
        return;
      }
      this.hideSoon();
      window.clearTimeout(this.showTimer);
      if (position) this.showTimer = window.setTimeout(() => { void this.look(position); }, 300);
    });
    editor.onMouseLeave(() => {
      window.clearTimeout(this.showTimer);
      this.hideSoon();
    });
    editor.onKeyDown((event) => { if (event.keyCode === monaco.KeyCode.Escape) this.hide(); });
    editor.onDidScrollChange((event) => { if (event.scrollTopChanged || event.scrollLeftChanged) this.hide(); });
    editor.onDidChangeModelContent(() => this.hide());
    editor.onDidChangeModel(() => this.hide());
    editor.addContentWidget(this);
  }

  getId(): string { return this.id; }

  getDomNode(): HTMLElement { return this.node; }

  getPosition(): monaco.editor.IContentWidgetPosition | null {
    if (!this.position) return null;
    const { BELOW, ABOVE } = monaco.editor.ContentWidgetPositionPreference;
    return { position: this.position, preference: [BELOW, ABOVE] };
  }

  // Gone, and a look under way with it.
  hide(): void {
    window.clearTimeout(this.showTimer);
    this.looks += 1;
    this.close();
  }

  private close(): void {
    window.clearTimeout(this.hideTimer);
    if (!this.position) return;
    this.position = null;
    this.range = null;
    this.node.replaceChildren();
    this.editor.layoutContentWidget(this);
  }

  // A moment to move into the popup. A look started meanwhile, at another name, goes on.
  private hideSoon(): void {
    if (!this.position) return;
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.close(), 300);
  }

  private async look(position: monaco.Position): Promise<void> {
    const model = this.editor.getModel();
    if (!model) return;
    this.looks += 1;
    const look = this.looks;
    const found = await this.find(model, position);
    if (look !== this.looks || !found) return;
    window.clearTimeout(this.hideTimer);
    this.range = monaco.Range.lift(found.range);
    this.node.replaceChildren(found.content);
    this.position = { lineNumber: this.range.startLineNumber, column: this.range.startColumn };
    this.editor.layoutContentWidget(this);
  }
}
