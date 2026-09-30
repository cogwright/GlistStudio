import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filesIn, searchFolders } from '../src/file-search.ts';
import { fuzzyMatch } from '../src/fuzzy.ts';
import { declarationAt } from '../src/symbol-signature.ts';
import { findInText, queryPattern } from '../src/text-search.ts';

// Find in Files, and Search Everywhere's files and symbols. Run with jiti.

// Text: as typed, whole words, case, regular expressions.
const find = (text, query) => findInText(text, queryPattern(query)).map((match) => [match.line, match.column, match.length]);
const source = 'void draw();\r\n  gCanvas::draw(x);\nredraw(); DRAW\n';
assert.deepEqual(find(source, { text: 'draw' }), [[1, 6, 4], [2, 12, 4], [3, 3, 4], [3, 11, 4]]);
assert.deepEqual(find(source, { text: 'draw', matchCase: true }), [[1, 6, 4], [2, 12, 4], [3, 3, 4]]);
assert.deepEqual(find(source, { text: 'draw', wholeWords: true }), [[1, 6, 4], [2, 12, 4], [3, 11, 4]]);
// Characters regular expressions use are plain text unless asked.
assert.deepEqual(find(source, { text: '::draw(' }), [[2, 10, 7]]);
assert.deepEqual(find(source, { text: '::draw(', wholeWords: true }), [[2, 10, 7]]);
assert.deepEqual(find(source, { text: 'dr\\w+\\(', regex: true, matchCase: true }), [[1, 6, 5], [2, 12, 5], [3, 3, 5]]);
assert.deepEqual(find(source, { text: '^', regex: true }), []);
assert.throws(() => queryPattern({ text: '(', regex: true }));
assert.equal(queryPattern({ text: '' }), null);
// The line shows without its indent; a long one around the match.
const [indented] = findInText(source, queryPattern({ text: 'gCanvas' }));
assert.deepEqual([indented.preview, indented.previewStart], ['gCanvas::draw(x);', 0]);
const [far] = findInText(`${'x'.repeat(500)}needle${'y'.repeat(500)}`, queryPattern({ text: 'needle' }));
assert.equal(far.preview.slice(far.previewStart, far.previewStart + 6), 'needle');
assert.ok(far.preview.length <= 246 && far.previewStart === 40);
assert.equal(findInText('a a a a', queryPattern({ text: 'a' }), 2).length, 2);

// Letters in order, starts of words counting for more.
const rank = (query, names) => names
  .map((name) => ({ name, match: fuzzyMatch(query, name) }))
  .filter((entry) => entry.match)
  .sort((left, right) => right.match.score - left.match.score)
  .map((entry) => entry.name);
assert.deepEqual(rank('gcan', ['gCameraAnimation.h', 'gCanvas.cpp', 'main.cpp']), ['gCanvas.cpp', 'gCameraAnimation.h']);
assert.deepEqual(rank('gc', ['GameCanvas.cpp', 'gCanvas.h', 'logic.cpp']), ['gCanvas.h', 'GameCanvas.cpp', 'logic.cpp']);
assert.deepEqual(rank('main', ['gMainMenu.cpp', 'main.cpp']), ['main.cpp', 'gMainMenu.cpp']);
assert.equal(fuzzyMatch('xyz', 'gCanvas.cpp'), null);
assert.equal(fuzzyMatch('canvasx', 'canvas'), null);
assert.deepEqual(fuzzyMatch('gcc', 'gCanvas.cpp').positions, [0, 1, 8]);
// Accents and the dotless i do not matter.
assert.ok(fuzzyMatch('oyun', 'Oyun.cpp') && fuzzyMatch('cizim', 'Çizim.cpp') && fuzzyMatch('ilk', 'İlk.h'));

// Signatures, from the declaration's line.
const header = [
  'class gCanvas : public gBaseCanvas {',
  'public:',
  '  void draw(int x,',
  '            int y) override; // draws',
  '  int size = 3;',
  '};',
  '#define GLIST_VERSION 2',
].join('\n');
assert.equal(declarationAt(header, 0, 6), 'class gCanvas : public gBaseCanvas');
assert.equal(declarationAt(header, 2, 7), 'void draw(int x, int y) override');
assert.equal(declarationAt(header, 4, 6), 'int size = 3');
assert.equal(declarationAt(header, 6, 8), '#define GLIST_VERSION 2');
assert.equal(declarationAt('void gCanvas::setup() {\n}', 0, 14), 'void gCanvas::setup()');
assert.equal(declarationAt('', 3, 0), '');

// Files: the folders' own, without Git's, the builds' and binary ones.
const root = mkdtempSync(path.join(tmpdir(), 'glist-search-'));
try {
  const write = (relative, contents) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), contents);
  };
  write('App/src/gCanvas.cpp', 'void gCanvas::setup() {\n  logo.load("logo.png");\n}\n');
  write('App/src/gCanvas.h', 'class gCanvas {\n  gImage logo;\n};\n');
  write('App/CMakeLists.txt', 'set(PLUGINS gipDemo)\n');
  write('App/.git/config', 'logo\n');
  write('App/_build/Release/compile_commands.json', 'logo\n');
  write('App/assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0x6c, 0x6f, 0x67, 0x6f]));
  write('GlistEngine/engine/graphics/gImage.h', 'class gImage {\n  void load(const std::string& logo);\n};\n');
  const project = { path: path.join(root, 'App'), name: 'App', kind: 'project' };
  const engine = { path: path.join(root, 'GlistEngine'), name: 'GlistEngine', kind: 'engine' };

  const listed = await filesIn([project, engine]);
  assert.deepEqual(listed.map((file) => `${file.owner}:${file.relative}`), [
    'App:CMakeLists.txt', 'App:assets/logo.png', 'App:src/gCanvas.cpp', 'App:src/gCanvas.h',
    'GlistEngine:engine/graphics/gImage.h',
  ]);
  assert.equal(listed[0].kind, 'project');
  assert.equal(listed[4].path, path.join(root, 'GlistEngine', 'engine', 'graphics', 'gImage.h'));
  assert.equal((await filesIn([project], 2)).length, 2);

  const inProject = await searchFolders([project], { text: 'logo' });
  assert.deepEqual(inProject.files.map((file) => [file.relative, file.matches.map((match) => match.line)]), [
    ['src/gCanvas.cpp', [2, 2]], ['src/gCanvas.h', [2]],
  ]);
  assert.deepEqual([inProject.matches, inProject.limited], [3, false]);
  const everywhere = await searchFolders([project, engine], { text: 'logo', wholeWords: true, matchCase: true });
  assert.deepEqual(everywhere.files.map((file) => `${file.owner}:${file.relative}`), ['App:src/gCanvas.cpp', 'App:src/gCanvas.h', 'GlistEngine:engine/graphics/gImage.h']);
  // Up to the limit, saying there were more.
  const limited = await searchFolders([project, engine], { text: 'logo' }, 2);
  assert.deepEqual([limited.matches, limited.limited, limited.files.length], [2, true, 1]);
  // A newer search stops this one.
  assert.equal((await searchFolders([project], { text: 'logo' }, 2000, () => true)).files.length, 0);
  assert.equal((await searchFolders([project], { text: '' })).matches, 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Search tests passed.');
