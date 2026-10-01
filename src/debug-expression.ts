// What the debugger evaluates for a hover, from the line's text. No Monaco, so it can be tested on its own.

// The expression under the pointer on a line: a name, with the names before it
// that reach it through . or ->, as hero.score or current->score. Null on a
// function's name, which clangd describes better than its address.
export const expressionAt = (line: string, column: number): { expression: string; start: number; end: number } | null => {
  const at = column - 1;
  const word = /[A-Za-z_]\w*/g;
  let found: RegExpExecArray | null = null;
  for (let match = word.exec(line); match; match = word.exec(line)) {
    if (match.index <= at && at <= match.index + match[0].length) { found = match; break; }
  }
  if (!found || /^\d/.test(found[0])) return null;
  const end = found.index + found[0].length;
  if (/^\s*\(/.test(line.slice(end))) return null;
  const reach = /(?:[A-Za-z_]\w*\s*(?:\.|->)\s*)*$/.exec(line.slice(0, found.index));
  const start = found.index - (reach?.[0].length ?? 0);
  return { expression: line.slice(start, end).replace(/\s+/g, ''), start: start + 1, end: end + 1 };
};
