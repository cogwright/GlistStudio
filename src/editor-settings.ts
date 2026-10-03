// eslint-disable-next-line import/no-unresolved
import type * as monaco from 'monaco-editor/editor/editor.api';

// How the editor's caret looks and moves, how it scrolls, wraps and what it
// shows beside the code, from Settings > Editor, and Reduce motion from
// Settings > Appearance, which stills the caret, scrolling and the interface's
// animations. Every editor follows a change at once, as with fonts (fonts.ts).

export type CaretStyle = 'line' | 'block' | 'underline';

export interface EditorSettings {
  caretStyle: CaretStyle;
  smoothCaret: boolean;
  smoothScrolling: boolean;
  wordWrap: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  reduceMotion: boolean;
}

const storageKey = 'glist-studio-editor';
const caretStyles: CaretStyle[] = ['line', 'block', 'underline'];
// Reduce motion starts as the system has it.
const defaults = (): EditorSettings => ({
  caretStyle: 'line', smoothCaret: true, smoothScrolling: true, wordWrap: false, minimap: true, stickyScroll: true,
  reduceMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
});

export const loadEditorSettings = (): EditorSettings => {
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? '{}') as Partial<EditorSettings>;
    const fallback = defaults();
    const flag = (key: keyof EditorSettings): boolean => (typeof saved[key] === 'boolean' ? saved[key] as boolean : fallback[key] as boolean);
    return {
      caretStyle: caretStyles.includes(saved.caretStyle as CaretStyle) ? saved.caretStyle as CaretStyle : fallback.caretStyle,
      smoothCaret: flag('smoothCaret'),
      smoothScrolling: flag('smoothScrolling'),
      wordWrap: flag('wordWrap'),
      minimap: flag('minimap'),
      stickyScroll: flag('stickyScroll'),
      reduceMotion: flag('reduceMotion'),
    };
  } catch {
    return defaults();
  }
};

// The settings as Monaco's editors take them.
export const editorBehaviour = (settings: EditorSettings): monaco.editor.IEditorOptions => ({
  cursorStyle: settings.caretStyle,
  cursorSmoothCaretAnimation: settings.smoothCaret && !settings.reduceMotion ? 'on' : 'off',
  smoothScrolling: settings.smoothScrolling && !settings.reduceMotion,
  wordWrap: settings.wordWrap ? 'on' : 'off',
  minimap: { enabled: settings.minimap },
  stickyScroll: { enabled: settings.stickyScroll },
});

// What Reduce motion does outside the editor: index.css stills transitions and animations.
const applyMotion = (settings: EditorSettings): void => {
  document.documentElement.toggleAttribute('data-reduce-motion', settings.reduceMotion);
};

const listeners: Array<(settings: EditorSettings) => void> = [];

export const onEditorSettingsChange = (listener: (settings: EditorSettings) => void): void => {
  listeners.push(listener);
  listener(loadEditorSettings());
};

export interface EditorSettingsControls {
  caretStyle: HTMLSelectElement;
  smoothCaret: HTMLInputElement;
  smoothScrolling: HTMLInputElement;
  wordWrap: HTMLInputElement;
  minimap: HTMLInputElement;
  stickyScroll: HTMLInputElement;
  reduceMotion: HTMLInputElement;
}

export const setUpEditorSettings = (controls: EditorSettingsControls): void => {
  const settings = loadEditorSettings();
  const switches = ['smoothCaret', 'smoothScrolling', 'wordWrap', 'minimap', 'stickyScroll', 'reduceMotion'] as const;
  controls.caretStyle.value = settings.caretStyle;
  switches.forEach((name) => { controls[name].checked = settings[name]; });
  applyMotion(settings);
  const update = (): void => {
    const next = { caretStyle: caretStyles.includes(controls.caretStyle.value as CaretStyle) ? controls.caretStyle.value as CaretStyle : 'line' } as EditorSettings;
    switches.forEach((name) => { next[name] = controls[name].checked; });
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    applyMotion(next);
    listeners.forEach((listener) => listener(next));
  };
  controls.caretStyle.addEventListener('change', update);
  switches.forEach((name) => controls[name].addEventListener('change', update));
};
