// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';

// CMake, which Monaco has no grammar for. Token names match the ones themes color;
// ${VAR} expands like a macro and is colored like one.
export const registerCmakeLanguage = (): void => {
  monaco.languages.register({ id: 'cmake', extensions: ['.cmake'], filenames: ['CMakeLists.txt'], aliases: ['CMake'] });
  monaco.languages.setLanguageConfiguration('cmake', {
    comments: { lineComment: '#', blockComment: ['#[[', ']]'] },
    brackets: [['(', ')'], ['{', '}']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
    ],
    surroundingPairs: [{ open: '(', close: ')' }, { open: '"', close: '"' }],
    indentationRules: {
      increaseIndentPattern: /^\s*(if|elseif|else|foreach|while|function|macro|block)\s*\(.*$/i,
      decreaseIndentPattern: /^\s*(elseif|else|endif|endforeach|endwhile|endfunction|endmacro|endblock)\s*\(.*$/i,
    },
  });
  monaco.languages.setMonarchTokensProvider('cmake', {
    ignoreCase: true,
    keywords: [
      'if', 'elseif', 'else', 'endif', 'foreach', 'endforeach', 'while', 'endwhile', 'function', 'endfunction',
      'macro', 'endmacro', 'block', 'endblock', 'return', 'break', 'continue',
    ],
    operators: [
      'NOT', 'AND', 'OR', 'COMMAND', 'POLICY', 'TARGET', 'TEST', 'DEFINED', 'EXISTS', 'IS_NEWER_THAN', 'IS_DIRECTORY',
      'IS_SYMLINK', 'IS_ABSOLUTE', 'MATCHES', 'LESS', 'GREATER', 'EQUAL', 'LESS_EQUAL', 'GREATER_EQUAL', 'STRLESS',
      'STRGREATER', 'STREQUAL', 'STRLESS_EQUAL', 'STRGREATER_EQUAL', 'VERSION_LESS', 'VERSION_GREATER', 'VERSION_EQUAL',
      'VERSION_LESS_EQUAL', 'VERSION_GREATER_EQUAL', 'IN_LIST',
    ],
    constants: ['ON', 'OFF', 'TRUE', 'FALSE', 'YES', 'NO', 'Y', 'N', 'IGNORE', 'NOTFOUND'],
    tokenizer: {
      root: [
        [/#\[(=*)\[/, { token: 'comment', next: '@bracketComment.$1' }],
        [/#.*$/, 'comment'],
        [/\[(=*)\[/, { token: 'string', next: '@bracketString.$1' }],
        [/"/, { token: 'string', next: '@string' }],
        [/\$\{/, { token: 'macro', next: '@variable' }],
        [/\$ENV\{[^}]*\}/, 'macro'],
        [/\$<[^>]*>/, 'annotation'],
        [/([A-Za-z_][A-Za-z0-9_]*)(\s*)(\()/, [{ cases: { '@keywords': 'keyword', '@default': 'function' } }, '', 'delimiter.parenthesis']],
        [/[A-Za-z_][A-Za-z0-9_]*/, { cases: { '@operators': 'keyword', '@constants': 'constant', '@default': 'identifier' } }],
        [/\d+(\.\d+)*/, 'number'],
        [/[()]/, 'delimiter.parenthesis'],
        [/[^\s()#"$]+/, 'identifier'],
      ],
      string: [
        [/\$\{/, { token: 'macro', next: '@variable' }],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string', next: '@pop' }],
        [/[^"\\$]+/, 'string'],
        [/\$/, 'string'],
      ],
      variable: [
        [/\$\{/, { token: 'macro', next: '@variable' }],
        [/\}/, { token: 'macro', next: '@pop' }],
        [/[^}$]+/, 'macro'],
        [/\$/, 'macro'],
      ],
      bracketComment: [
        [/\](=*)\]/, { cases: { '$1==$S2': { token: 'comment', next: '@pop' }, '@default': 'comment' } }],
        [/[^\]]+|\]/, 'comment'],
      ],
      bracketString: [
        [/\](=*)\]/, { cases: { '$1==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }],
        [/[^\]]+|\]/, 'string'],
      ],
    },
  });
};
