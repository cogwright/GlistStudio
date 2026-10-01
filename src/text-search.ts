// Finding text in a file, the same way in the backend, which reads files from
// disk, and in the window, which has the ones not saved yet: as typed, or as a
// regular expression, with case and whole words as asked. No DOM, no Node.

export interface TextQuery {
  text: string;
  matchCase?: boolean;
  wholeWords?: boolean;
  regex?: boolean;
}

export interface TextMatch {
  // 1-based, as the editor counts.
  line: number;
  column: number;
  length: number;
  // The line without its indent, or the part of a long one around the match, and where the match starts in it.
  preview: string;
  previewStart: number;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordCharacter = /\w/;

// The pattern for a query, or null when there is nothing to find. A regular
// expression that does not parse throws. Whole words means no letter, digit or
// underscore right before or after, where the text itself starts or ends with
// one, as VS Code does.
export const queryPattern = (query: TextQuery): RegExp | null => {
  if (!query.text) return null;
  let source = query.regex ? query.text : escape(query.text);
  if (query.wholeWords) {
    const before = query.regex || wordCharacter.test(query.text[0]) ? '(?<!\\w)' : '';
    const after = query.regex || wordCharacter.test(query.text[query.text.length - 1]) ? '(?!\\w)' : '';
    source = `${before}(?:${source})${after}`;
  }
  return new RegExp(source, query.matchCase ? 'g' : 'gi');
};

const previewOf = (line: string, start: number, length: number): Pick<TextMatch, 'preview' | 'previewStart'> => {
  const indent = line.length - line.trimStart().length;
  let from = Math.min(indent, start);
  // A long line shows from a little before the match.
  if (start - from > 80) from = start - 40;
  const to = Math.min(line.length, Math.max(from + 240, start + length));
  return { preview: line.slice(from, to), previewStart: start - from };
};

// Every match in a text, up to a limit, line by line: a match does not span lines.
export const findInText = (text: string, pattern: RegExp, limit = Infinity): TextMatch[] => {
  const matches: TextMatch[] = [];
  pattern.lastIndex = 0;
  if (limit <= 0 || !pattern.test(text)) return matches;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    pattern.lastIndex = 0;
    for (let found = pattern.exec(line); found && matches.length < limit; found = pattern.exec(line)) {
      // A pattern that matches nothing, such as ^, moves on instead of finding the same place again.
      if (found[0].length === 0) { pattern.lastIndex += 1; continue; }
      matches.push({ line: index + 1, column: found.index + 1, length: found[0].length, ...previewOf(line, found.index, found[0].length) });
    }
  }
  return matches;
};
