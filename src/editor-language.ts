// Monaco's own words, such as its right-click menu and find box, in the
// interface language. Monaco looks them up while it loads, from a table its
// Turkish package sets, so this is imported before Monaco itself, and a
// change of language reaches them the next time the studio starts.
// eslint-disable-next-line import/no-unresolved
import 'monaco-editor/nls/lang/tr';

const saved = ((): string | null => {
  try { return window.localStorage.getItem('glist-studio-language'); } catch { return null; }
})();

// Microsoft's Turkish words that read oddly, as the rest of the studio says them.
const better: Record<string, string> = {
  'Tüm Oluşumları Değiştirir': 'Tüm Geçtiği Yerleri Değiştir',
};

const globals = globalThis as { _VSCODE_NLS_MESSAGES?: unknown; _VSCODE_NLS_LANGUAGE?: unknown };
if (saved === 'tr' && Array.isArray(globals._VSCODE_NLS_MESSAGES)) {
  globals._VSCODE_NLS_MESSAGES = globals._VSCODE_NLS_MESSAGES.map((message: unknown) =>
    (typeof message === 'string' ? better[message] ?? message : message));
} else if (saved !== 'tr') {
  // English is Monaco's own; without the table it falls back to it.
  delete globals._VSCODE_NLS_MESSAGES;
  delete globals._VSCODE_NLS_LANGUAGE;
}

// The language Monaco's words are in until the studio starts again.
export const editorLanguage = saved === 'tr' ? 'tr' : 'en';
