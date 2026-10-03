// eslint-disable-next-line import/no-unresolved
import * as monaco from 'monaco-editor/editor/editor.api';

// TOML, which Monaco does not know: its tables, keys, strings (the multi-line
// ones too), numbers, dates and booleans, coloured with the same names INI's
// and YAML's are (a table like an INI section, a key like a YAML key).

const key = /(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*(?=\s*=)/;

export const registerTomlLanguage = (): void => {
  monaco.languages.register({ id: 'toml', extensions: ['.toml'], aliases: ['TOML'] });

  monaco.languages.setLanguageConfiguration('toml', {
    comments: { lineComment: '#' },
    brackets: [['[', ']'], ['{', '}']],
    autoClosingPairs: [
      { open: '[', close: ']' }, { open: '{', close: '}' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
    ],
    surroundingPairs: [{ open: '[', close: ']' }, { open: '{', close: '}' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
  });

  monaco.languages.setMonarchTokensProvider('toml', {
    tokenPostfix: '.toml',
    tokenizer: {
      root: [
        [/^\s*\[\[[^\]]*\]\]/, 'metatag'],
        [/^\s*\[[^\]]*\]/, 'metatag'],
        { include: '@line' },
      ],
      line: [
        [/[ \t]+/, ''],
        [/#.*$/, 'comment'],
        [key, 'key'],
        [/=/, 'delimiter'],
        [/"""/, 'string', '@multiBasic'],
        [/'''/, 'string', '@multiLiteral'],
        [/"/, 'string', '@basic'],
        [/'/, 'string', '@literal'],
        [/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/, 'number'],
        [/\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/, 'number'],
        [/[+-]?(?:inf|nan)\b/, 'number'],
        [/0x[\dA-Fa-f_]+|0o[0-7_]+|0b[01_]+/, 'number'],
        [/[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/, 'number'],
        [/\b(?:true|false)\b/, 'keyword'],
        [/[[\]{}]/, '@brackets'],
        [/,/, 'delimiter'],
      ],
      basic: [[/[^"\\]+/, 'string'], [/\\./, 'string.escape'], [/"/, 'string', '@pop']],
      literal: [[/[^']+/, 'string'], [/'/, 'string', '@pop']],
      multiBasic: [[/"""/, 'string', '@pop'], [/[^"\\]+/, 'string'], [/\\./, 'string.escape'], [/"/, 'string']],
      multiLiteral: [[/'''/, 'string', '@pop'], [/[^']+/, 'string'], [/'/, 'string']],
    },
  });
};
