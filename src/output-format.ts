// Output from builds and programs, as DOM nodes: ANSI colors become spans in
// theme colors, and file locations such as src/gCanvas.cpp:12:5 become links.

// The line the Output panel starts a build, run or debug session with, in
// the window's or the backend's words.
export const outputBanner = (title: string): string => `\n── ${title} ${'─'.repeat(Math.max(4, 45 - title.length))}\n`;

const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

export interface OutputStyle {
  color: string | null;
  bold: boolean;
  // An escape sequence cut off at the end of the previous chunk.
  pending: string;
}

export const newOutputStyle = (): OutputStyle => ({ color: null, bold: false, pending: '' });

// SGR parameters: reset, bold, and foreground colors (basic, bright, 256 and RGB).
const applySgr = (style: OutputStyle, parameters: string): void => {
  const codes = parameters === '' ? [0] : parameters.split(';').map(Number);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) { style.color = null; style.bold = false; }
    else if (code === 1) style.bold = true;
    else if (code === 22) style.bold = false;
    else if (code === 39) style.color = null;
    else if (code >= 30 && code <= 37) style.color = ansiNames[code - 30];
    else if (code >= 90 && code <= 97) style.color = ansiNames[code - 90];
    else if (code === 38 && codes[index + 1] === 5) {
      const value = codes[index + 2];
      style.color = value < 8 ? ansiNames[value] : value < 16 ? ansiNames[value - 8] : null;
      index += 2;
    } else if (code === 38 && codes[index + 1] === 2) {
      style.color = `rgb(${codes[index + 2]}, ${codes[index + 3]}, ${codes[index + 4]})`;
      index += 4;
    }
  }
};

const location = /((?:[A-Za-z]:)?[^\s:()'"<>]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|cmake|txt)):(\d+)(?::(\d+))?/g;

const withLinks = (text: string, open: (path: string, line: number) => void): Node[] => {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(location)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(document.createTextNode(text.slice(last, index)));
    const link = document.createElement('a');
    link.className = 'output-link';
    link.href = '#';
    link.textContent = match[0];
    link.addEventListener('click', (event) => { event.preventDefault(); open(match[1], Number(match[2])); });
    nodes.push(link);
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
};

export const formatOutput = (chunk: string, style: OutputStyle, open: (path: string, line: number) => void): Node[] => {
  let text = style.pending + chunk;
  style.pending = '';
  // ANSI escape sequences start with the ESC control character.
  // eslint-disable-next-line no-control-regex
  const cut = /\x1b(\[[0-9;?]*)?$/.exec(text);
  if (cut) {
    style.pending = cut[0];
    text = text.slice(0, cut.index);
  }
  const nodes: Node[] = [];
  let last = 0;
  const emit = (part: string): void => {
    if (!part) return;
    const content = withLinks(part, open);
    if (!style.color && !style.bold) { nodes.push(...content); return; }
    const span = document.createElement('span');
    if (style.color?.startsWith('rgb')) span.style.color = style.color;
    else if (style.color) span.className = `ansi-${style.color}`;
    if (style.bold) span.classList.add('ansi-bold');
    span.append(...content);
    nodes.push(span);
  };
  // eslint-disable-next-line no-control-regex
  for (const match of text.matchAll(/\x1b\[([0-9;?]*)([A-Za-z])/g)) {
    emit(text.slice(last, match.index));
    if (match[2] === 'm') applySgr(style, match[1]);
    last = (match.index ?? 0) + match[0].length;
  }
  emit(text.slice(last));
  return nodes;
};
