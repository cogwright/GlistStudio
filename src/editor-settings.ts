// eslint-disable-next-line import/no-unresolved
import type * as monaco from 'monaco-editor/editor/editor.api';

// How the editor's caret looks and moves, and how it scrolls, from Settings >
// Editor. Every editor follows a change at once, as with fonts (fonts.ts).

export type CaretStyle = 'line' | 'block' | 'underline';

export interface EditorSettings {
  caretStyle: CaretStyle;
  smoothCaret: boolean;
  smoothScrolling: boolean;
}

const storageKey = 'glist-studio-editor';
const caretStyles: CaretStyle[] = ['line', 'block', 'underline'];
const defaults: EditorSettings = { caretStyle: 'line', smoothCaret: true, smoothScrolling: true };

export const loadEditorSettings = (): EditorSettings => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Partial<EditorSettings>;
    return {
      caretStyle: caretStyles.includes(saved.caretStyle as CaretStyle) ? saved.caretStyle as CaretStyle : defaults.caretStyle,
      smoothCaret: saved.smoothCaret !== false,
      smoothScrolling: saved.smoothScrolling !== false,
    };
  } catch {
    return { ...defaults };
  }
};

// The settings as Monaco's editors take them.
export const editorBehaviour = (settings: EditorSettings): monaco.editor.IEditorOptions => ({
  cursorStyle: settings.caretStyle,
  cursorSmoothCaretAnimation: settings.smoothCaret ? 'on' : 'off',
  smoothScrolling: settings.smoothScrolling,
});

const listeners: Array<(settings: EditorSettings) => void> = [];

export const onEditorSettingsChange = (listener: (settings: EditorSettings) => void): void => {
  listeners.push(listener);
  listener(loadEditorSettings());
};

export interface EditorSettingsControls {
  caretStyle: HTMLSelectElement;
  smoothCaret: HTMLInputElement;
  smoothScrolling: HTMLInputElement;
}

export const setUpEditorSettings = (controls: EditorSettingsControls): void => {
  const settings = loadEditorSettings();
  controls.caretStyle.value = settings.caretStyle;
  controls.smoothCaret.checked = settings.smoothCaret;
  controls.smoothScrolling.checked = settings.smoothScrolling;
  const update = (): void => {
    const next: EditorSettings = {
      caretStyle: caretStyles.includes(controls.caretStyle.value as CaretStyle) ? controls.caretStyle.value as CaretStyle : defaults.caretStyle,
      smoothCaret: controls.smoothCaret.checked,
      smoothScrolling: controls.smoothScrolling.checked,
    };
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    listeners.forEach((listener) => listener(next));
  };
  controls.caretStyle.addEventListener('change', update);
  [controls.smoothCaret, controls.smoothScrolling].forEach((input) => input.addEventListener('change', update));
};
