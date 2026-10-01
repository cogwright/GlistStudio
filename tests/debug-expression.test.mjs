import assert from 'node:assert/strict';
import { expressionAt } from '../src/debug-expression.ts';

// What hovering evaluates while paused. Columns are 1-based, as the editor counts. Run with jiti.
const at = (line, word, nth = 0) => {
  let index = -1;
  for (let count = 0; count <= nth; count += 1) index = line.indexOf(word, index + 1);
  return expressionAt(line, index + 2)?.expression ?? null;
};
const line = '\ttotal += current->score + levels.size() + hero . name.length;';
assert.equal(at(line, 'total'), 'total');
assert.equal(at(line, 'current'), 'current');
// A member is evaluated with what reaches it.
assert.equal(at(line, 'score'), 'current->score');
assert.equal(at(line, 'name'), 'hero.name');
assert.equal(at(line, 'length'), 'hero.name.length');
// A function's name, called or a member called, is left to clangd.
assert.equal(at(line, 'size'), null);
assert.equal(at('\tint total = movePlayer(hero, 3);', 'movePlayer'), null);
assert.equal(at('\tint total = movePlayer (hero, 3);', 'movePlayer'), null);
assert.equal(at('\tint total = movePlayer(hero, 3);', 'hero'), 'hero');
// Nothing on spaces, numbers or symbols.
assert.equal(expressionAt('\ttotal += 35;', 1), null);
assert.equal(at('\ttotal += 35;', '35'), null);
assert.equal(expressionAt('a + b', 3), null);
// The range covers what is evaluated, 1-based and end-exclusive.
assert.deepEqual(expressionAt('x = p->y;', 8), { expression: 'p->y', start: 5, end: 9 });

console.log('Debug expression tests passed.');
