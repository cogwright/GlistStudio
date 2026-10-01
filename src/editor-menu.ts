// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';
import { type MenuEntry } from './context-menu';
import { t, type TranslationKey } from './localization';
import { isLinux, reformatShortcut } from './shortcuts';

// The editor's right-click menu, drawn by the studio instead of Monaco, so it
// looks like the others and its words follow the interface language at once.
// It holds what Monaco's held; the command palette lists the same commands.

export interface EditorCommand {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

export interface EditorMenuHooks {
  // Whether clangd answers for C++ files: definitions, references and the like.
  navigates(): boolean;
  switchSourceHeader(): void;
  commandPalette(): void;
  // Reformat File, or the lines chosen, by the .clang-format.
  reformat(): void;
  // Git's entries for the file, while Git is on and knows it.
  git(): MenuEntry[];
}

// The editor's commands, grouped as its menu shows them. Code navigation only
// in the main editor, not in a diff.
const groups = (editor: monaco.editor.ICodeEditor, hooks: EditorMenuHooks, navigation: boolean): {
  navigate: EditorCommand[]; peek: EditorCommand[]; change: EditorCommand[]; clipboard: EditorCommand[];
} => {
  const model = editor.getModel();
  const writable = !editor.getOption(monaco.editor.EditorOption.readOnly);
  const cpp = navigation && model?.getLanguageId() === 'cpp';
  const navigates = cpp && hooks.navigates();
  // Monaco's own command, run in the editor, which needs focus for it.
  const command = (id: string, key: TranslationKey, shortcut?: string): EditorCommand => ({
    id, label: t(key), shortcut, run: () => { editor.focus(); editor.trigger('menu', id, null); },
  });
  const supported = (id: string): boolean => Boolean(editor.getAction(id)?.isSupported());
  const selection = editor.getSelection();
  return {
    navigate: [
      ...(cpp ? [{ id: 'glist.switchSourceHeader', label: t('switchSourceHeader'), shortcut: 'Alt+O', run: hooks.switchSourceHeader }] : []),
      ...(navigates ? [
        command('editor.action.revealDefinition', 'goToDefinition', 'F12'),
        command('editor.action.revealDeclaration', 'goToDeclaration'),
        command('editor.action.goToReferences', 'goToReferences', 'Shift+F12'),
      ] : []),
      ...(navigation && supported('editor.action.quickOutline') ? [command('editor.action.quickOutline', 'goToSymbol', 'Ctrl+Shift+O')] : []),
    ],
    peek: navigates ? [
      command('editor.action.peekDefinition', 'peekDefinition', isLinux ? 'Ctrl+Shift+F10' : 'Alt+F12'),
      command('editor.action.peekDeclaration', 'peekDeclaration'),
      command('editor.action.referenceSearch.trigger', 'peekReferences'),
    ] : [],
    change: writable ? [
      ...(supported('editor.action.rename') ? [command('editor.action.rename', 'renameSymbol', 'F2')] : []),
      ...(supported('editor.action.changeAll') ? [command('editor.action.changeAll', 'changeAllOccurrences', 'Ctrl+F2')] : []),
      ...(model?.getLanguageId() === 'cpp' ? [{
        id: 'glist.reformat', label: t(selection && !selection.isEmpty() ? 'reformatSelection' : 'reformatFile'), shortcut: reformatShortcut, run: hooks.reformat,
      }] : []),
    ] : [],
    clipboard: [
      ...(writable ? [command('editor.action.clipboardCutAction', 'cut', 'Ctrl+X')] : []),
      command('editor.action.clipboardCopyAction', 'copy', 'Ctrl+C'),
      ...(writable ? [command('editor.action.clipboardPasteAction', 'paste', 'Ctrl+V')] : []),
    ],
  };
};

export const editorMenu = (editor: monaco.editor.ICodeEditor, hooks: EditorMenuHooks, navigation = true): MenuEntry[] => {
  const { navigate, peek, change, clipboard } = groups(editor, hooks, navigation);
  const git = navigation ? hooks.git() : [];
  return [
    ...navigate,
    ...(peek.length > 0 ? [{ label: t('peek'), children: peek }] : []),
    'separator',
    ...change,
    'separator',
    ...clipboard,
    ...(git.length > 0 ? ['separator' as const, { label: t('menuGit'), children: git }] : []),
    'separator',
    { label: t('commandPalette'), shortcut: 'Ctrl+P', run: hooks.commandPalette },
  ];
};

// The same commands for the command palette, without the palette itself.
export const editorCommands = (editor: monaco.editor.ICodeEditor, hooks: EditorMenuHooks): EditorCommand[] => {
  const { navigate, peek, change, clipboard } = groups(editor, hooks, true);
  return [...navigate, ...peek, ...change, ...clipboard];
};

// Opens the menu from the keyboard, at the cursor.
export const editorMenuPoint = (editor: monaco.editor.ICodeEditor): { clientX: number; clientY: number } => {
  const bounds = editor.getDomNode()?.getBoundingClientRect();
  const position = editor.getPosition();
  const cursor = position && editor.getScrolledVisiblePosition(position);
  return {
    clientX: (bounds?.left ?? 0) + (cursor?.left ?? 0),
    clientY: (bounds?.top ?? 0) + (cursor ? cursor.top + cursor.height : 0),
  };
};
