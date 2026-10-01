// Matching typed letters to a name the way an IDE's file search does: in
// order but not necessarily together, so "gcan" finds gCanvas.cpp. Letters at
// the start of the name or of a word in it, and letters together, count for
// more. The scoring is fzy's (github.com/jhawthorn/fzy). Case, accents and a
// dotless i do not matter. No DOM.

export interface FuzzyMatch {
  score: number;
  // Where each typed letter matched, for showing them.
  positions: number[];
}

const gapLeading = -0.005;
const gapTrailing = -0.005;
const gapInner = -0.01;
const consecutive = 1;
const exactBonus = 10;

// One character to compare, keeping positions: é as e, İ and ı as i.
const plain = (character: string): string =>
  (character === 'ı' ? 'i' : character.normalize('NFD')[0].toLowerCase()[0] ?? character);

// What a letter at a place is worth: the start, after a folder separator, after
// _ - . or a space, and a capital after a small letter start a word.
const bonusAt = (text: string, index: number): number => {
  if (index === 0) return 0.9;
  const before = text[index - 1];
  if (before === '/' || before === '\\') return 0.9;
  if (before === '_' || before === '-' || before === '.' || before === ' ') return 0.8;
  if (/[a-z]/.test(before) && /[A-Z]/.test(text[index])) return 0.7;
  return 0;
};

export const fuzzyMatch = (query: string, candidate: string): FuzzyMatch | null => {
  const needle = [...query].map(plain);
  const hay = [...candidate];
  const lower = hay.map(plain);
  const n = needle.length;
  const m = hay.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > m) return null;
  // Quick refusal: the letters must all be there, in order.
  for (let i = 0, j = 0; i < n; i += 1, j += 1) {
    while (j < m && lower[j] !== needle[i]) j += 1;
    if (j === m) return null;
  }
  const bonus = hay.map((_, index) => bonusAt(candidate, index));
  // best[i][j]: the best score of the first i+1 letters within the first j+1 characters;
  // ending[i][j]: the same with letter i matched right at j.
  const best = needle.map(() => new Array<number>(m).fill(-Infinity));
  const ending = needle.map(() => new Array<number>(m).fill(-Infinity));
  for (let i = 0; i < n; i += 1) {
    let previous = -Infinity;
    const gap = i === n - 1 ? gapTrailing : gapInner;
    for (let j = 0; j < m; j += 1) {
      if (lower[j] === needle[i]) {
        let score = -Infinity;
        if (i === 0) score = j * gapLeading + bonus[j];
        else if (j > 0) score = Math.max(best[i - 1][j - 1] + bonus[j], ending[i - 1][j - 1] + consecutive);
        ending[i][j] = score;
        previous = Math.max(score, previous + gap);
      } else {
        previous += gap;
      }
      best[i][j] = previous;
    }
  }
  // Back from the end, the places that gave the best score.
  const positions = new Array<number>(n);
  let required = false;
  for (let i = n - 1, j = m - 1; i >= 0; i -= 1) {
    for (; j >= 0; j -= 1) {
      if (ending[i][j] !== -Infinity && (required || ending[i][j] === best[i][j])) {
        required = i > 0 && j > 0 && best[i][j] === ending[i - 1][j - 1] + consecutive;
        positions[i] = j;
        j -= 1;
        break;
      }
    }
  }
  const score = best[n - 1][m - 1] + (n === m && needle.join('') === lower.join('') ? exactBonus : 0);
  return { score, positions };
};
