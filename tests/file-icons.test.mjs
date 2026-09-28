import assert from 'node:assert/strict';
import { fileIcon } from '../src/file-icons.ts';

const glyphOf = (name) => fileIcon(name).glyph.codePointAt(0).toString(16);

assert.equal(glyphOf('gCanvas.cpp'), 'e01a');
assert.deepEqual(fileIcon('gCanvas.cpp').color, 'blue');
assert.equal(glyphOf('gCanvas.h'), 'e01a');
assert.equal(fileIcon('gCanvas.h').color, 'purple');
assert.equal(fileIcon('CMakeLists.txt').color, 'blue');
assert.equal(glyphOf('CMakeLists.txt'), 'e05f');
assert.equal(glyphOf('notes.txt'), 'e023');
assert.equal(glyphOf('LICENSE'), 'e05a');
assert.equal(glyphOf('README.md'), 'e04d');
assert.equal(glyphOf('CHANGES.md'), 'e060');
assert.equal(glyphOf('.gitignore'), 'e034');
assert.equal(glyphOf('FreeSans.TTF'), 'e033');
assert.equal(glyphOf('logo.png'), 'e04c');
assert.equal(glyphOf('Makefile'), 'e05f');
// Names without a known type, including ones that match Object's properties, are plain files.
for (const name of ['constructor', 'a.constructor', 'a.__proto__', 'toString', 'shader.glsl', 'noextension', 'trailing.']) {
  assert.equal(glyphOf(name), 'e023', name);
}
console.log('File icon tests passed.');
