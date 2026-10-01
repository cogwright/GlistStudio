import { lineChanges } from './line-diff';

// Format on save for the lines changed since the file was last saved, not the
// whole file, as other editors' "modifications" mode does. No Monaco, so it
// can be tested on its own.

export interface LineRange {
  // 1-based, both ends included.
  start: number;
  end: number;
}

export interface LineEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
}

// clangd sorts an #include block a range touches; ranges leave those lines out,
// so formatting never moves an #include.
const include = /^\s*#\s*(?:include|import)\b/;

// The lines of the text as it is that differ from the saved one, in ranges,
// #include lines left out. Lines only removed leave nothing to format.
export const changedLines = (saved: string, current: string): LineRange[] => {
  const lines = current.split('\n');
  const ranges: LineRange[] = [];
  for (const change of lineChanges(saved, current)) {
    let start = 0;
    for (let line = change.modifiedStart; line < change.modifiedStart + change.modifiedCount; line += 1) {
      if (include.test(lines[line - 1] ?? '')) {
        if (start) ranges.push({ start, end: line - 1 });
        start = 0;
      } else if (!start) start = line;
    }
    if (start) ranges.push({ start, end: change.modifiedStart + change.modifiedCount - 1 });
  }
  return ranges;
};

// The edits for the ranges that stay on their lines, each once: clang-format
// may reach the line break before a range, but not lines nobody changed.
export const editsWithin = (edits: LineEdit[], ranges: LineRange[]): LineEdit[] => {
  const inside = (edit: LineEdit): boolean => ranges.some((range) =>
    edit.range.endLineNumber >= range.start && edit.range.endLineNumber <= range.end
    && edit.range.startLineNumber >= range.start - 1 && edit.range.startLineNumber <= range.end);
  const sorted = edits.filter(inside).sort((a, b) => a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn);
  const kept: LineEdit[] = [];
  for (const edit of sorted) {
    const last = kept[kept.length - 1];
    const same = last && JSON.stringify(last) === JSON.stringify(edit);
    const after = !last || last.range.endLineNumber < edit.range.startLineNumber
      || (last.range.endLineNumber === edit.range.startLineNumber && last.range.endColumn <= edit.range.startColumn);
    // One that overlaps another, or repeats it from a neighbouring range, is left out.
    if (after && !same) kept.push(edit);
  }
  return kept;
};
