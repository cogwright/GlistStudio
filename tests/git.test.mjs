import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  branchFormat, logFormat, parseBlame, parseBranches, parseLog, parseNameStatus, parseRemotes, parseStashes, parseStatus,
  parseTags, stashFormat, tagFormat,
} from '../src/git.ts';
import { lineChanges } from '../src/line-diff.ts';
import { graphRows } from '../src/git-graph.ts';
import { conflictBlocks, resolvedLines } from '../src/conflicts.ts';

// The parsers read what git itself prints, in a repository made for the test.
const root = mkdtempSync(path.join(tmpdir(), 'glist-git-'));
const repo = path.join(root, 'repo');
// Each command a second later, so commits sort by date the way they were made.
let clock = 1700000000;
const git = (...args) => {
  clock += 1;
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', HOME: root, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  });
};
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

try {
  mkdirSync(repo);
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.com');

  let status = parseStatus(git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching'));
  assert.equal(status.branch, 'main');
  assert.equal(status.head, null);
  assert.deepEqual(status.changes, []);

  write('src/main.cpp', 'int main() {\n  return 0;\n}\n');
  write('src/old name.h', '#pragma once\n');
  write('.gitignore', '_build/\n');
  write('_build/app', 'binary');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit', '-m', 'With a body.');

  write('src/main.cpp', 'int main() {\n  return 1;\n}\n');
  write('src/new file.cpp', '\n');
  git('mv', 'src/old name.h', 'src/new name.h');
  write('README.md', 'staged\n');
  git('add', 'README.md');
  status = parseStatus(git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching'));
  assert.match(status.head, /^[0-9a-f]{40}$/);
  const byPath = Object.fromEntries(status.changes.map((change) => [change.path, change]));
  assert.deepEqual(byPath['src/main.cpp'], { path: 'src/main.cpp', state: 'modified', staged: false });
  assert.deepEqual(byPath['src/new file.cpp'], { path: 'src/new file.cpp', state: 'untracked', staged: false });
  assert.deepEqual(byPath['src/new name.h'], { path: 'src/new name.h', from: 'src/old name.h', state: 'renamed', staged: true });
  assert.deepEqual(byPath['README.md'], { path: 'README.md', state: 'added', staged: true });
  assert.deepEqual(status.ignored, ['_build/']);
  git('commit', '-q', '-am', 'Second commit');

  // Branches, tags, a merge with a conflict.
  git('checkout', '-q', '-b', 'feature');
  write('src/main.cpp', 'int main() {\n  return 2;\n}\n');
  git('commit', '-q', '-am', 'Return two');
  git('tag', '-a', 'v1', '-m', 'Version one');
  git('tag', 'light');
  git('checkout', '-q', 'main');
  write('src/main.cpp', 'int main() {\n  return 3;\n}\n');
  git('commit', '-q', '-am', 'Return three');
  try { git('merge', 'feature'); } catch { /* It stops on the conflict. */ }
  status = parseStatus(git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'));
  assert.deepEqual(status.changes.find((change) => change.path === 'src/main.cpp'),
    { path: 'src/main.cpp', state: 'conflict', staged: false, conflict: 'UU' });
  git('merge', '--abort');

  const branches = parseBranches(git('for-each-ref', `--format=${branchFormat}`, 'refs/heads', 'refs/remotes'));
  assert.deepEqual(branches.map((branch) => [branch.name, branch.current, branch.remote]), [['feature', false, false], ['main', true, false]]);
  assert.equal(branches[1].subject, 'Return three');

  const tags = parseTags(git('for-each-ref', `--format=${tagFormat}`, 'refs/tags'));
  const feature = git('rev-parse', '--short', 'feature').trim();
  assert.deepEqual(tags.map((tag) => [tag.name, tag.commit]), [['light', feature], ['v1', feature]]);
  assert.equal(tags[1].subject, 'Version one');

  // A remote that main tracks, one commit behind.
  git('init', '-q', '--bare', path.join(root, 'remote.git'));
  git('remote', 'add', 'origin', path.join(root, 'remote.git'));
  git('push', '-q', '-u', 'origin', 'main');
  write('src/main.cpp', 'int main() {\n  return 4;\n}\n');
  git('commit', '-q', '-am', 'Return four');
  const tracked = parseBranches(git('for-each-ref', `--format=${branchFormat}`, 'refs/heads', 'refs/remotes'));
  const main = tracked.find((branch) => branch.name === 'main');
  assert.equal(main.upstream, 'origin/main');
  assert.equal(main.ahead, 1);
  assert.equal(main.behind, 0);
  assert.ok(tracked.some((branch) => branch.name === 'origin/main' && branch.remote));
  assert.ok(!tracked.some((branch) => branch.ref.endsWith('/HEAD')));
  status = parseStatus(git('status', '--porcelain=v2', '--branch', '-z'));
  assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 1);

  assert.deepEqual(parseRemotes(git('remote', '-v')), [{ name: 'origin', fetch: path.join(root, 'remote.git'), push: path.join(root, 'remote.git') }]);

  const log = parseLog(git('log', '--all', '--date-order', `--format=${logFormat}`));
  assert.deepEqual(log.map((commit) => commit.subject), ['Return four', 'Return three', 'Return two', 'Second commit', 'First commit']);
  assert.equal(log[0].author, 'Ada Lovelace');
  assert.equal(log[0].email, 'ada@example.com');
  assert.deepEqual(log[0].refs, ['main']);
  assert.deepEqual(log[1].refs, ['origin/main']);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.deepEqual(parseLog(git('log', '-1', '--format=' + logFormat, 'origin/main'))[0].refs, ['origin/main']);
  assert.deepEqual(log[2].refs, ['tag: v1', 'tag: light', 'feature']);
  assert.equal(log[4].parents.length, 0);
  assert.equal(log[3].parents[0], log[4].hash);

  const files = parseNameStatus(git('diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', log[4].hash, log[3].hash));
  assert.deepEqual(files, [
    { path: 'README.md', state: 'added' },
    { path: 'src/main.cpp', state: 'modified' },
    { from: 'src/old name.h', path: 'src/new name.h', state: 'renamed' },
  ]);

  write('src/main.cpp', 'changed\n');
  git('stash', 'push', '-q', '-m', 'Try something');
  const stashes = parseStashes(git('stash', 'list', `--format=${stashFormat}`));
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].name, 'stash@{0}');
  assert.equal(stashes[0].message, 'On main: Try something');

  const blame = parseBlame(execFileSync('git', ['blame', '--line-porcelain', '--contents', '-', '--', 'src/main.cpp'], {
    cwd: repo, encoding: 'utf8', input: 'int main() {\n  return 4;\n}\n// new\n',
  }));
  assert.equal(blame.length, 4);
  assert.equal(blame[0].summary, 'First commit');
  assert.equal(blame[1].summary, 'Return four');
  assert.equal(blame[1].author, 'Ada Lovelace');
  assert.equal(blame[3].uncommitted, true);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Changed lines, for the markers beside the line numbers.
assert.deepEqual(lineChanges('a\nb\nc', 'a\nb\nc'), []);
assert.deepEqual(lineChanges('a\nb\nc', 'a\nB\nc'), [{ originalStart: 2, originalCount: 1, modifiedStart: 2, modifiedCount: 1 }]);
assert.deepEqual(lineChanges('a\nc', 'a\nb\nc'), [{ originalStart: 2, originalCount: 0, modifiedStart: 2, modifiedCount: 1 }]);
assert.deepEqual(lineChanges('a\nb\nc', 'a\nc'), [{ originalStart: 2, originalCount: 1, modifiedStart: 2, modifiedCount: 0 }]);
assert.deepEqual(lineChanges('a\nb', 'x\na\nb\ny'), [
  { originalStart: 1, originalCount: 0, modifiedStart: 1, modifiedCount: 1 },
  { originalStart: 3, originalCount: 0, modifiedStart: 4, modifiedCount: 1 },
]);
assert.deepEqual(lineChanges('a\nb\nc\nd\ne', 'a\nx\nc\ne\nf'), [
  { originalStart: 2, originalCount: 1, modifiedStart: 2, modifiedCount: 1 },
  { originalStart: 4, originalCount: 1, modifiedStart: 4, modifiedCount: 0 },
  { originalStart: 6, originalCount: 0, modifiedStart: 5, modifiedCount: 1 },
]);
assert.deepEqual(lineChanges('a\r\nb\r\n', 'a\nb\n'), []);
// A removed function is shown whole, not with the brace of the one above it.
assert.deepEqual(lineChanges('a\n}\n\nb\n}\n\nc', 'a\n}\n\nc'), [{ originalStart: 4, originalCount: 3, modifiedStart: 4, modifiedCount: 0 }]);
assert.deepEqual(lineChanges('a\n}\n\nc', 'a\n}\n\nb\n}\n\nc'), [{ originalStart: 4, originalCount: 0, modifiedStart: 4, modifiedCount: 3 }]);
// Applying the changes to the original gives the new text.
const apply = (original, modified) => {
  const before = original.split('\n');
  const after = modified.split('\n');
  const result = [...before];
  lineChanges(original, modified).reverse().forEach((change) => {
    result.splice(change.originalStart - 1, change.originalCount, ...after.slice(change.modifiedStart - 1, change.modifiedStart - 1 + change.modifiedCount));
  });
  return result.join('\n');
};
const random = (seed) => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const next = random(7);
for (let round = 0; round < 200; round += 1) {
  const lines = Array.from({ length: Math.floor(next() * 30) }, () => 'abcde'[Math.floor(next() * 5)]);
  const edited = lines.flatMap((line) => {
    const roll = next();
    if (roll < 0.15) return [];
    if (roll < 0.3) return [line, 'xyz'[Math.floor(next() * 3)]];
    if (roll < 0.4) return ['q'];
    return [line];
  });
  assert.equal(apply(lines.join('\n'), edited.join('\n')), edited.join('\n'));
}
// Past a thousand edits the middle of the file is one change.
const many = Array.from({ length: 3000 }, (_, index) => `line ${index}`);
const shuffled = many.map((line, index) => (index % 2 ? `${line}!` : line));
const big = lineChanges(many.join('\n'), shuffled.join('\n'));
assert.ok(big.length >= 1);
assert.equal(apply(many.join('\n'), shuffled.join('\n')), shuffled.join('\n'));

// The commit graph: a branch that forks and merges back.
//   m  merge of a and b
//   b  on the branch
//   a  on main
//   r  where both started
const rows = graphRows([
  { hash: 'm', parents: ['a', 'b'] },
  { hash: 'b', parents: ['r'] },
  { hash: 'a', parents: ['r'] },
  { hash: 'r', parents: [] },
]);
assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0, 0]);
assert.deepEqual(rows[0].lines.map(({ from, fromY, to, toY }) => [from, fromY, to, toY]), [[0, 0.5, 0, 1], [0, 0.5, 1, 1]]);
// b continues its lane down to r, which a's lane leads to as well.
assert.ok(rows[1].lines.some((line) => line.from === 1 && line.fromY === 0 && line.to === 1 && line.toY === 0.5));
assert.ok(rows[1].lines.some((line) => line.from === 0 && line.fromY === 0 && line.to === 0 && line.toY === 1));
assert.ok(rows[3].lines.some((line) => line.from === 1 && line.fromY === 0 && line.to === 0 && line.toY === 0.5));
assert.equal(rows[3].lines.filter((line) => line.fromY === 0.5).length, 0);
assert.equal(rows[0].lines.some((line) => line.fromY === 0), false);
assert.equal(rows[0].color === rows[2].color, true);
assert.notEqual(rows[1].color, rows[0].color);
// Two unrelated tips side by side.
const tips = graphRows([{ hash: 'x', parents: ['z'] }, { hash: 'y', parents: [] }, { hash: 'z', parents: [] }]);
assert.deepEqual(tips.map((row) => row.lane), [0, 1, 0]);

// Conflict markers.
const conflicted = [
  'before',
  '<<<<<<< HEAD',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> feature',
  'middle',
  '<<<<<<< HEAD',
  'mine 2',
  '||||||| base',
  'base 2',
  '=======',
  '>>>>>>> feature',
  '======= not a marker',
];
const blocks = conflictBlocks(conflicted);
assert.deepEqual(blocks, [{ start: 2, separator: 4, end: 6 }, { start: 8, base: 10, separator: 12, end: 13 }]);
assert.deepEqual(resolvedLines(conflicted, blocks[0], 'upper'), ['mine']);
assert.deepEqual(resolvedLines(conflicted, blocks[0], 'lower'), ['theirs']);
assert.deepEqual(resolvedLines(conflicted, blocks[0], 'both'), ['mine', 'theirs']);
assert.deepEqual(resolvedLines(conflicted, blocks[1], 'upper'), ['mine 2']);
assert.deepEqual(resolvedLines(conflicted, blocks[1], 'lower'), []);
assert.deepEqual(conflictBlocks(['<<<<<<< HEAD', 'never closed']), []);

console.log('Git tests passed.');
