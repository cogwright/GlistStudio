import assert from 'node:assert/strict';
import { EditorLayout } from '../src/editor-layout.ts';

// The editor's tabs on each side. Run with jiti.
const tabs = (layout) => layout.groups.map((group) => `${group.tabs.join(' ')}${group.active ? ` [${group.active}]` : ''}`);

// One group: tabs open at the end; the one closed makes way for its neighbor.
const layout = new EditorLayout();
['a.cpp', 'a.h', 'b.cpp'].forEach((key) => layout.activate(key));
assert.deepEqual(tabs(layout), ['a.cpp a.h b.cpp [b.cpp]']);
layout.add('c.cpp');
assert.deepEqual(tabs(layout), ['a.cpp a.h b.cpp c.cpp [b.cpp]'], 'added without coming to the front');
layout.activate('a.h');
layout.close('a.h');
assert.deepEqual(tabs(layout), ['a.cpp b.cpp c.cpp [b.cpp]']);
layout.close('c.cpp');
assert.deepEqual(tabs(layout), ['a.cpp b.cpp [b.cpp]'], 'a tab behind closes without changing the front');
layout.close('b.cpp');
assert.deepEqual(tabs(layout), ['a.cpp [a.cpp]'], 'the last one closed: the one before comes');

// Reordering in a group leaves the front alone.
layout.activate('b.cpp');
layout.activate('c.cpp');
layout.activate('a.cpp');
layout.move('c.cpp', 0, 0, 'a.cpp');
assert.deepEqual(tabs(layout), ['c.cpp a.cpp b.cpp [a.cpp]']);
layout.move('c.cpp', 0, 0);
assert.deepEqual(tabs(layout), ['a.cpp b.cpp c.cpp [a.cpp]']);

// Split Right: the same file on both sides, the new side focused.
layout.split('a.cpp');
assert.deepEqual(tabs(layout), ['a.cpp b.cpp c.cpp [a.cpp]', 'a.cpp [a.cpp]']);
assert.equal(layout.focused, 1);
assert.deepEqual(layout.groupsWith('a.cpp'), [0, 1]);
// New tabs go to the focused side.
layout.activate('a.h');
assert.deepEqual(tabs(layout), ['a.cpp b.cpp c.cpp [a.cpp]', 'a.cpp a.h [a.h]']);
assert.equal(layout.activeKey, 'a.h');
// Closing one of a file's two tabs leaves it open.
layout.close('a.cpp', 1);
assert.equal(layout.isOpen('a.cpp'), true);
assert.deepEqual(tabs(layout), ['a.cpp b.cpp c.cpp [a.cpp]', 'a.h [a.h]']);
// A third side is not made; split from the right opens on the left.
layout.split('a.h', 1);
assert.deepEqual(tabs(layout), ['a.cpp b.cpp c.cpp a.h [a.h]', 'a.h [a.h]']);
assert.equal(layout.focused, 0);
layout.close('a.h', 0);

// Dragging a tab across: it leaves one side for the other, before a tab there.
layout.move('b.cpp', 0, 1, 'a.h');
assert.deepEqual(tabs(layout), ['a.cpp c.cpp [c.cpp]', 'b.cpp a.h [b.cpp]']);
assert.equal(layout.focused, 1);
// Onto a side that has the file already: the two become one.
layout.split('a.cpp', 0);
layout.move('a.cpp', 0, 1);
assert.deepEqual(tabs(layout), ['c.cpp [c.cpp]', 'b.cpp a.h a.cpp [a.cpp]']);
// A side left empty goes, and the other takes the whole area.
layout.move('c.cpp', 0, 1, 'b.cpp');
assert.deepEqual(tabs(layout), ['c.cpp b.cpp a.h a.cpp [c.cpp]']);
assert.equal(layout.focused, 0);
// A group one past the last is a new side, the way a drop at the right edge makes it.
layout.move('a.h', 0, 1);
assert.deepEqual(tabs(layout), ['c.cpp b.cpp a.cpp [c.cpp]', 'a.h [a.h]']);
layout.move('a.h', 1, 2);
assert.equal(layout.groups.length, 2, 'never more than two sides');

// Closing the last tab on the right, or on the left, leaves one side.
layout.close('a.h', 1);
assert.deepEqual(tabs(layout), ['c.cpp b.cpp a.cpp [c.cpp]']);
assert.equal(layout.focused, 0);
layout.split('b.cpp', 0);
layout.focus(0);
['c.cpp', 'b.cpp', 'a.cpp'].forEach((key) => layout.close(key, 0));
assert.deepEqual(tabs(layout), ['b.cpp [b.cpp]']);
assert.equal(layout.focused, 0);

// A rename keeps places; a deleted folder takes its tabs from both sides.
layout.activate('src/x.cpp');
layout.split('src/x.cpp');
layout.activate('src/y.cpp');
layout.rename('src/x.cpp', 'src/z.cpp');
assert.deepEqual(tabs(layout), ['b.cpp src/z.cpp [src/z.cpp]', 'src/z.cpp src/y.cpp [src/y.cpp]']);
layout.remove((key) => key.startsWith('src/'));
assert.deepEqual(tabs(layout), ['b.cpp [b.cpp]']);
assert.deepEqual(layout.keys(), ['b.cpp']);
layout.clear();
assert.deepEqual(tabs(layout), ['']);
assert.equal(layout.activeKey, null);

console.log('Editor layout tests passed.');
