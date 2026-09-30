// What a symbol clangd finds is declared as, read from the source where it
// is: "void gCanvas::draw(int x, int y)", "class gCanvas : public gBaseCanvas".
// clangd names a symbol but gives no signature, so the declaration's text,
// from the start of its line to its body or end, stands in, on one line. No DOM.

const longest = 160;

// line and character are 0-based, as the language server counts.
export const declarationAt = (source: string, line: number, character: number): string => {
  const lines = source.split('\n').slice(line, line + 6).map((text) => text.replace(/\r$/, ''));
  if (lines.length === 0) return '';
  let text = '';
  let depth = 0;
  // From the start of the symbol's line, through the lines its brackets still open.
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].replace(/\/\/.*$/, '');
    let end = current.length;
    for (let at = 0; at < current.length; at += 1) {
      const letter = current[at];
      if (letter === '(' || letter === '[') depth += 1;
      else if ((letter === ')' || letter === ']') && depth > 0) depth -= 1;
      // The body or the end of the declaration, past the name.
      else if (depth === 0 && (letter === '{' || letter === ';') && (index > 0 || at >= character)) { end = at; break; }
    }
    text += ` ${current.slice(0, end)}`;
    if (end < current.length || depth === 0) break;
  }
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length > longest ? `${plain.slice(0, longest - 3)}...` : plain;
};
