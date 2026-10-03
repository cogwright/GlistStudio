// Which lines of a file changed since a commit, for the markers beside the
// editor's line numbers: Myers' shortest edit script over whole lines.

export interface LineChange {
  // 1-based. A count of 0 means lines were only added or only removed there;
  // the start is then the line before which it happened.
  originalStart: number;
  originalCount: number;
  modifiedStart: number;
  modifiedCount: number;
}

// Past this many single-line edits, the middle of the file counts as one change.
const maxEdits = 1000;

// The lines of both texts as numbers, equal for equal lines.
const lineIds = (original: string[], modified: string[]): [number[], number[]] => {
  const ids = new Map<string, number>();
  const id = (line: string): number => {
    let value = ids.get(line);
    if (value === undefined) { value = ids.size; ids.set(line, value); }
    return value;
  };
  return [original.map(id), modified.map(id)];
};

// Pairs of equal lines, in order, or null when the texts differ too much.
const matchingLines = (a: number[], b: number[]): Array<[number, number]> | null => {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // The furthest x on each diagonal after each round, from diagonal -d to d.
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d += 1) {
    if (d > maxEdits) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) done = true;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  const matches: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d - 1];
    const at = (k: number): number => previous[k + d - 1];
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; matches.push([x, y]); }
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; matches.push([x, y]); }
  return matches.reverse();
};

// Where a line of the original text is in the modified one: a line changed is
// where what replaced it starts, a line removed is the line after it, and any
// other line moves as the changes above it moved it.
export const mapLine = (changes: LineChange[], line: number): number => {
  let shift = 0;
  for (const change of changes) {
    if (line < change.originalStart) break;
    if (line < change.originalStart + change.originalCount) {
      return change.modifiedStart + Math.min(line - change.originalStart, Math.max(change.modifiedCount - 1, 0));
    }
    shift = change.modifiedStart + change.modifiedCount - (change.originalStart + change.originalCount);
  }
  return line + shift;
};

export const lineChanges = (originalText: string, modifiedText: string): LineChange[] => {
  if (originalText === modifiedText) return [];
  const [original, modified] = lineIds(originalText.split(/\r?\n/), modifiedText.split(/\r?\n/));
  // Most edits touch a small part of a file, so the equal start and end are set aside first.
  let prefix = 0;
  while (prefix < original.length && prefix < modified.length && original[prefix] === modified[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < modified.length - prefix
    && original[original.length - 1 - suffix] === modified[modified.length - 1 - suffix]) suffix += 1;
  const a = original.slice(prefix, original.length - suffix);
  const b = modified.slice(prefix, modified.length - suffix);
  const matches = matchingLines(a, b) ?? [];
  const changes: LineChange[] = [];
  let lastA = 0;
  let lastB = 0;
  [...matches, [a.length, b.length] as [number, number]].forEach(([nextA, nextB]) => {
    if (nextA > lastA || nextB > lastB) {
      changes.push({
        originalStart: prefix + lastA + 1,
        originalCount: nextA - lastA,
        modifiedStart: prefix + lastB + 1,
        modifiedCount: nextB - lastB,
      });
    }
    lastA = nextA + 1;
    lastB = nextB + 1;
  });
  return slideDown(changes, original, modified);
};

// Lines only added or only removed can often sit a few lines higher or lower
// with the same result, such as a removed function taking the closing brace
// above it instead of its own. Like git, each goes as far down as it can, so
// it starts where the function starts.
const slideDown = (changes: LineChange[], original: number[], modified: number[]): LineChange[] => changes.map((change, index) => {
  if ((change.originalCount === 0) === (change.modifiedCount === 0)) return change;
  const next = changes[index + 1];
  const endA = next ? next.originalStart - 1 : original.length;
  const endB = next ? next.modifiedStart - 1 : modified.length;
  let a = change.originalStart - 1;
  let b = change.modifiedStart - 1;
  if (change.modifiedCount === 0) {
    while (a + change.originalCount < endA && b < endB && original[a] === original[a + change.originalCount]) { a += 1; b += 1; }
  } else {
    while (b + change.modifiedCount < endB && a < endA && modified[b] === modified[b + change.modifiedCount]) { a += 1; b += 1; }
  }
  return { ...change, originalStart: a + 1, modifiedStart: b + 1 };
});
