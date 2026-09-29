// Conflict markers that git leaves in a file it could not merge:
//
//   <<<<<<< HEAD
//   the version on this branch
//   ||||||| base            (only with merge.conflictStyle diff3 or zdiff3)
//   the version both started from
//   =======
//   the incoming version
//   >>>>>>> feature

export interface ConflictBlock {
  // 1-based lines of the markers.
  start: number;
  base?: number;
  separator: number;
  end: number;
}

// The part above the ======= line, the part below it, or both in that order.
export type ConflictChoice = 'upper' | 'lower' | 'both';

const marker = (line: string, character: string): boolean =>
  line.startsWith(character.repeat(7)) && (line.length === 7 || /\s/.test(line[7]));

export const conflictBlocks = (lines: string[]): ConflictBlock[] => {
  const blocks: ConflictBlock[] = [];
  let open: Partial<ConflictBlock> | null = null;
  lines.forEach((line, index) => {
    const number = index + 1;
    if (marker(line, '<')) open = { start: number };
    else if (!open) return;
    else if (marker(line, '|') && open.separator === undefined) open.base = number;
    else if (marker(line, '=') && line.trimEnd() === '=======' && open.separator === undefined) open.separator = number;
    else if (marker(line, '>') && open.separator !== undefined) {
      blocks.push({ ...open, end: number } as ConflictBlock);
      open = null;
    }
  });
  return blocks;
};

// The lines that replace a block, markers included, for the part chosen.
export const resolvedLines = (lines: string[], block: ConflictBlock, choice: ConflictChoice): string[] => {
  const upper = lines.slice(block.start, (block.base ?? block.separator) - 1);
  const lower = lines.slice(block.separator, block.end - 1);
  if (choice === 'upper') return upper;
  if (choice === 'lower') return lower;
  return [...upper, ...lower];
};
