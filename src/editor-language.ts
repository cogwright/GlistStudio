// Monaco's own words, such as its right-click menu and find box, in the
// interface language. Monaco looks them up while it loads, from a table its
// language packages set, so this is imported before Monaco itself, and a
// change of language reaches them the next time the studio starts.
import { words as tr } from './editor-words-tr';
import { savedLanguage, type Language } from './localization';

const tables: Partial<Record<Language, unknown>> = { tr };

// Microsoft's words that read oddly, as the rest of the studio says them.
const better: Record<string, string> = {
  'Tüm Oluşumları Değiştirir': 'Tüm Geçtiği Yerleri Değiştir',
};

// The language Monaco's words are in until the studio starts again.
export const editorLanguage = savedLanguage();

const globals = globalThis as { _VSCODE_NLS_MESSAGES?: unknown; _VSCODE_NLS_LANGUAGE?: unknown };
const table = tables[editorLanguage];
if (Array.isArray(table)) {
  globals._VSCODE_NLS_MESSAGES = table.map((message: unknown) => (typeof message === 'string' ? better[message] ?? message : message));
  globals._VSCODE_NLS_LANGUAGE = editorLanguage;
} else {
  // English is Monaco's own; without the table it falls back to it.
  delete globals._VSCODE_NLS_MESSAGES;
  delete globals._VSCODE_NLS_LANGUAGE;
}
