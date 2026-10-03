import { parseAllDocuments } from 'yaml';

// Reformat File for settings files, and the mistakes in them: YAML laid out
// again by the yaml library, which keeps its comments; TOML and INI tidied line
// by line, leaving what is inside a multi-line string or array as written.
// JSON is Monaco's own (its JSON service formats and checks it).

export type DataLanguage = 'json' | 'yaml' | 'toml' | 'ini';
export const isDataLanguage = (id: string): id is DataLanguage => ['json', 'yaml', 'toml', 'ini'].includes(id);

// Where a file has a mistake, from line 1 and column 1.
export interface DataProblem { line: number; column: number; endLine: number; endColumn: number; message: string }

// Thrown when a file cannot be laid out because it has a mistake.
export class DataFormatError extends Error {
  constructor(readonly problem: DataProblem) {
    super(problem.message);
  }
}

const lineEnding = (text: string): string => (/\r\n/.test(text) ? '\r\n' : '\n');

export const yamlProblems = (text: string): DataProblem[] => parseAllDocuments(text)
  .flatMap((document) => (Array.isArray(document.errors) ? document.errors : []))
  .map((error) => {
    const [start, end] = error.linePos ?? [];
    return {
      line: start?.line ?? 1,
      column: start?.col ?? 1,
      endLine: end?.line ?? start?.line ?? 1,
      endColumn: end?.col ?? (start?.col ?? 1) + 1,
      // Where it is, the marker shows already.
      message: error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''),
    };
  });

// smol-toml is an ES module only, which this CommonJS build imports only so.
const loadToml = (): Promise<typeof import('smol-toml', { with: { 'resolution-mode': 'import' } })> => import('smol-toml');
let toml: ReturnType<typeof loadToml> | null = null;

export const tomlProblems = async (text: string): Promise<DataProblem[]> => {
  toml ??= loadToml();
  const { parse } = await toml;
  try {
    parse(text);
    return [];
  } catch (error) {
    const { line = 1, column = 1, message = String(error) } = error as { line?: number; column?: number; message?: string };
    const said = message.split('\n')[0].replace(/^Invalid TOML document: /, '');
    return [{ line, column, endLine: line, endColumn: column + 1, message: said.charAt(0).toUpperCase() + said.slice(1) }];
  }
};

export const formatYaml = (text: string, indent = 2): string => {
  const [problem] = yamlProblems(text);
  if (problem) throw new DataFormatError(problem);
  if (!text.trim()) return text;
  const documents = parseAllDocuments(text);
  const laid = (Array.isArray(documents) ? documents : []).map((document) => document.toString({ indent, lineWidth: 0, minContentWidth: 0 })).join('');
  return laid.replace(/\n/g, lineEnding(text));
};

// What a line leaves open for the next: a multi-line string, and how deep in
// brackets it is, outside strings and comments.
interface Open { string: '"""' | "'''" | null; depth: number }
const scan = (line: string, open: Open): Open => {
  let { string, depth } = open;
  let index = 0;
  while (index < line.length) {
    if (string) {
      const close = line.indexOf(string, index);
      if (close < 0) return { string, depth };
      index = close + 3;
      string = null;
      continue;
    }
    const character = line[index];
    if (character === '#') break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      string = line.slice(index, index + 3) as '"""' | "'''";
      index += 3;
    } else if (character === '"' || character === "'") {
      index += 1;
      while (index < line.length && line[index] !== character) index += character === '"' && line[index] === '\\' ? 2 : 1;
      index += 1;
    } else {
      if (character === '[' || character === '{') depth += 1;
      if (character === ']' || character === '}') depth = Math.max(0, depth - 1);
      index += 1;
    }
  }
  return { string, depth };
};

// The first = outside quotes, or -1.
const assignment = (line: string): number => {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote) {
      if (character === '\\' && quote === '"') index += 1;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '#' || character === ';') return -1;
    else if (character === '=') return index;
  }
  return -1;
};

// Blank lines kept to one, one before each table or section, trailing spaces
// gone, a single line break at the end, key = value spaced so. TOML's keys and
// tables lose their indentation, which TOML does not mind; INI's keep it, as
// some readers take an indented line for the one before it, continued.
const tidy = (text: string, kind: 'toml' | 'ini'): string => {
  const out: string[] = [];
  let blank = false;
  let open: Open = { string: null, depth: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (open.string || open.depth > 0) {
      out.push(open.string ? line : line.trimEnd());
      open = scan(line, open);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) { blank = out.length > 0; continue; }
    const header = /^\[/.test(trimmed);
    if (blank) out.push('');
    else if (header) {
      // Before the comments that say what the table is, not between them and it.
      let at = out.length;
      while (at > 0 && /^\s*[#;]/.test(out[at - 1])) at -= 1;
      if (at > 0 && out[at - 1] !== '') out.splice(at, 0, '');
    }
    blank = false;
    const indent = kind === 'ini' ? line.slice(0, line.length - line.trimStart().length) : '';
    const equals = header || /^[#;]/.test(trimmed) ? -1 : assignment(trimmed);
    out.push(equals > 0 ? `${indent}${trimmed.slice(0, equals).trimEnd()} = ${trimmed.slice(equals + 1).trimStart()}` : `${indent}${trimmed}`);
    if (kind === 'toml' && !header) open = scan(trimmed, open);
  }
  return out.length ? `${out.join(lineEnding(text))}${lineEnding(text)}` : '';
};

export const formatToml = async (text: string): Promise<string> => {
  const [problem] = await tomlProblems(text);
  if (problem) throw new DataFormatError(problem);
  return tidy(text, 'toml');
};

export const formatIni = (text: string): string => tidy(text, 'ini');
