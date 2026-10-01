import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

// The .clang-format a C or C++ file follows, found as clang-format finds it:
// the nearest .clang-format or _clang-format in the file's folder or one above.
// clangd formats with it on its own; the editor takes from it whether to indent
// with tabs, how far, and where lines end, and formats with it on save. No Electron.

export interface CodeStyle {
  // The .clang-format it comes from.
  file: string;
  useTab: boolean;
  indentWidth: number;
  tabWidth: number;
  // 0 for no limit.
  columnLimit: number;
  // DisableFormat: the file asks not to be formatted.
  disabled: boolean;
}

type Values = Omit<CodeStyle, 'file'>;

// What each predefined style starts from, as clang-format defines them.
const predefined: Record<string, Values> = {
  llvm: { useTab: false, indentWidth: 2, tabWidth: 8, columnLimit: 80, disabled: false },
  google: { useTab: false, indentWidth: 2, tabWidth: 8, columnLimit: 80, disabled: false },
  chromium: { useTab: false, indentWidth: 2, tabWidth: 8, columnLimit: 80, disabled: false },
  mozilla: { useTab: false, indentWidth: 2, tabWidth: 8, columnLimit: 80, disabled: false },
  webkit: { useTab: false, indentWidth: 4, tabWidth: 8, columnLimit: 0, disabled: false },
  microsoft: { useTab: false, indentWidth: 4, tabWidth: 4, columnLimit: 120, disabled: false },
  gnu: { useTab: false, indentWidth: 2, tabWidth: 8, columnLimit: 79, disabled: false },
};

const styleFiles = ['.clang-format', '_clang-format'];

// The nearest style file at or above a folder, or null.
const styleFileFrom = (folder: string): string | null => {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    const found = styleFiles.map((name) => path.join(current, name)).find((candidate) => existsSync(candidate));
    if (found) return found;
    if (path.dirname(current) === current) return null;
  }
};

// The top-level keys of each YAML document in the file, as text.
const documents = (text: string): Array<Record<string, string>> => text
  .split(/^---\s*$/m)
  .map((part) => Object.fromEntries(part.split(/\r?\n/)
    .map((line) => /^([A-Za-z]+)\s*:\s*([^#]*?)\s*(?:#.*)?$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')])))
  .filter((keys) => Object.keys(keys).length > 0);

// The values for C++: the document without a Language, then the Cpp one on top.
// BasedOnStyle: InheritParentConfig starts from the style file further up.
export const parseStyle = (text: string, parent: () => Values = () => predefined.llvm): Values => {
  const parts = documents(text);
  const keys = { ...parts.find((part) => !part.Language), ...parts.find((part) => part.Language?.toLowerCase() === 'cpp') };
  const base = (keys.BasedOnStyle ?? 'LLVM').toLowerCase();
  const values = { ...(base === 'inheritparentconfig' ? parent() : predefined[base] ?? predefined.llvm) };
  const number = (key: string): number | undefined => (/^\d+$/.test(keys[key] ?? '') ? Number(keys[key]) : undefined);
  if (keys.UseTab) values.useTab = !/^(never|false)$/i.test(keys.UseTab);
  values.indentWidth = number('IndentWidth') ?? values.indentWidth;
  values.tabWidth = number('TabWidth') ?? values.tabWidth;
  values.columnLimit = number('ColumnLimit') ?? values.columnLimit;
  if (keys.DisableFormat) values.disabled = /^true$/i.test(keys.DisableFormat);
  return values;
};

// The style a file follows, or null when no style file is above it.
export const codeStyleFor = async (filePath: string): Promise<CodeStyle | null> => {
  const read = async (folder: string): Promise<CodeStyle | null> => {
    const file = styleFileFrom(folder);
    if (!file) return null;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    const above = /^\s*BasedOnStyle\s*:\s*InheritParentConfig/im.test(text) ? await read(path.dirname(path.dirname(file))) : null;
    return { ...parseStyle(text, () => above ?? predefined.llvm), file };
  };
  return read(path.dirname(path.resolve(filePath)));
};
