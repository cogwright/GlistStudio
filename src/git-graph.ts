// The lines of the commit graph beside the Git log. Each row is one commit,
// drawn in lanes: the commit sits in its lane, lines come in from the top for
// its children and go out at the bottom toward its parents, and other lanes
// pass straight through.

export interface GraphLine {
  from: number;
  // 0 is the row's top edge, 0.5 its commit, 1 its bottom edge.
  fromY: 0 | 0.5;
  to: number;
  toY: 0.5 | 1;
  // A lane keeps its color from where it starts to where it ends.
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  lines: GraphLine[];
  // Lanes wide.
  width: number;
}

// Commits come children first, as git log --date-order lists them.
export const graphRows = (commits: Array<{ hash: string; parents: string[] }>): GraphRow[] => {
  // The commit each lane leads to next, or null for a free lane.
  const lanes: Array<string | null> = [];
  const colors: number[] = [];
  let nextColor = 0;
  const freeLane = (): number => {
    const free = lanes.indexOf(null);
    return free < 0 ? lanes.length : free;
  };
  return commits.map(({ hash, parents }) => {
    let lane = lanes.indexOf(hash);
    // A branch tip: no line comes in from above.
    const tip = lane < 0;
    if (tip) {
      lane = freeLane();
      lanes[lane] = hash;
      colors[lane] = nextColor;
      nextColor += 1;
    }
    const color = colors[lane];
    const before = [...lanes];
    const lines: GraphLine[] = [];
    // Every lane that led here ends at the commit; the lowest one continues from it.
    before.forEach((expected, index) => {
      if (expected !== hash || (index === lane && tip)) return;
      lines.push({ from: index, fromY: 0, to: lane, toY: 0.5, color: colors[index] });
      if (index !== lane) lanes[index] = null;
    });
    // The first parent continues the lane, even when another lane also leads to
    // it; they meet at the parent, so a line of history stays straight.
    const [first, ...others] = parents;
    if (first === undefined) lanes[lane] = null;
    else {
      lanes[lane] = first;
      lines.push({ from: lane, fromY: 0.5, to: lane, toY: 1, color: colors[lane] });
    }
    others.forEach((parent) => {
      let target = lanes.indexOf(parent);
      if (target < 0) {
        target = freeLane();
        lanes[target] = parent;
        colors[target] = nextColor;
        nextColor += 1;
      }
      lines.push({ from: lane, fromY: 0.5, to: target, toY: 1, color: colors[target] });
    });
    before.forEach((expected, index) => {
      if (expected !== null && expected !== hash && lanes[index] === expected) {
        lines.push({ from: index, fromY: 0, to: index, toY: 1, color: colors[index] });
      }
    });
    const width = Math.max(before.length, lanes.length);
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    return { lane, color, lines, width };
  });
};
