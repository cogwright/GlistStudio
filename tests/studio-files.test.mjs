import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codeStyleFor, parseStyle } from '../src/code-style.ts';
import { initializeStudio, openProjectAt, pluginDllFolders, studio, systemFolders } from '../src/studio.ts';

// What the studio may write: the project, and the engine and the plugins the
// project names, which only build from an app. Run with jiti.
const root = mkdtempSync(path.join(tmpdir(), 'glist-files-'));
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const at = (file) => path.join(root, file);

try {
  write('GlistEngine/engine/core/gCore.h', '// core\n');
  write('glistplugins/gipDemo/src/gipDemo.h', '// demo\n');
  write('glistplugins/gipOther/src/gipOther.h', '// other\n');
  write('zbin/include/tool.h', '// tool\n');
  write('myglistapps/App/CMakeLists.txt', 'set(PLUGINS gipDemo)\n');
  write('myglistapps/App/src/main.cpp', 'int main() {}\n');
  symlinkSync(at('zbin/include/tool.h'), at('glistplugins/gipDemo/src/tool.h'));
  initializeStudio({
    send: () => undefined, trashItem: async () => undefined, showItemInFolder: () => undefined, openPath: async () => undefined,
    templateRoot: root, projectsDirectory: at('myglistapps'),
  });
  await openProjectAt(at('myglistapps/App'));

  await studio.writeFile(at('myglistapps/App/src/main.cpp'), 'int main() { return 0; }\n');
  assert.equal(readFileSync(at('myglistapps/App/src/main.cpp'), 'utf8'), 'int main() { return 0; }\n');
  await studio.writeFile(at('GlistEngine/engine/core/gCore.h'), '// core, edited\n');
  assert.equal(readFileSync(at('GlistEngine/engine/core/gCore.h'), 'utf8'), '// core, edited\n');
  await studio.writeFile(at('glistplugins/gipDemo/src/gipDemo.h'), '// demo, edited\n');
  assert.equal(readFileSync(at('glistplugins/gipDemo/src/gipDemo.h'), 'utf8'), '// demo, edited\n');
  // A file deleted behind the editor's back is written again.
  rmSync(at('glistplugins/gipDemo/src/gipDemo.h'));
  await studio.writeFile(at('glistplugins/gipDemo/src/gipDemo.h'), '// demo, again\n');
  assert.equal(readFileSync(at('glistplugins/gipDemo/src/gipDemo.h'), 'utf8'), '// demo, again\n');

  // Not a plugin the project names, the tools, a link out of a plugin, or the plugin folder itself.
  await assert.rejects(studio.writeFile(at('glistplugins/gipOther/src/gipOther.h'), 'x'));
  await assert.rejects(studio.writeFile(at('zbin/include/tool.h'), 'x'));
  await assert.rejects(studio.writeFile(at('glistplugins/gipDemo/src/tool.h'), 'x'));
  await assert.rejects(studio.writeFile(at('glistplugins/gipDemo/missing/new.h'), 'x'));
  assert.equal(readFileSync(at('zbin/include/tool.h'), 'utf8'), '// tool\n');
  assert.equal(readFileSync(at('glistplugins/gipOther/src/gipOther.h'), 'utf8'), '// other\n');

  // The DLL folders of the plugins the project names, the ones that exist, in the order named.
  write('glistplugins/gipDemo/libs/bin/demo.dll', '');
  write('glistplugins/gipDemo/prebuilts/bin/extra.dll', '');
  write('glistplugins/gipOther/libs/bin/other.dll', '');
  write('glistplugins/gipCairo/prebuilts/bin/cairo.dll', '');
  write('myglistapps/App/CMakeLists.txt', 'set(PLUGINS gipCairo gipDemo gipMissing)\n');
  assert.deepEqual(pluginDllFolders(at('myglistapps/App')), [
    at('glistplugins/gipCairo/prebuilts/bin'), at('glistplugins/gipDemo/libs/bin'), at('glistplugins/gipDemo/prebuilts/bin'),
  ]);
  write('myglistapps/App/CMakeLists.txt', 'set(PLUGINS)\n');
  assert.deepEqual(pluginDllFolders(at('myglistapps/App')), []);
  assert.deepEqual(pluginDllFolders(at('myglistapps/Missing')), []);

  // Settings > PATH: this computer's folders, then the ones added, which must be whole folders.
  const kept = await studio.setCustomPath([at('tools'), 'relative/tools', `${at('a')}${path.delimiter}${at('b')}`, at('tools/'), at('tools/../tools'), 7]);
  assert.deepEqual(kept, [at('tools')], 'only absolute folders without the separator, each once');
  write('tools/tool.txt', '');
  // Not the PATH the studio was started with: a folder only there is left out.
  write('os-only/tool.txt', '');
  const startedWith = process.env.PATH;
  process.env.PATH = [at('os-only'), startedWith].join(path.delimiter);
  const entries = await studio.pathEntries();
  process.env.PATH = startedWith;
  assert.equal(entries.some((entry) => entry.path === at('os-only')), false);
  assert.deepEqual(entries.filter((entry) => entry.source === 'system').map((entry) => entry.path), systemFolders());
  assert.ok(systemFolders().length > 0 && systemFolders().every((folder) => existsSync(folder)));
  assert.deepEqual(entries.slice(-1).map((entry) => [entry.path, entry.source, entry.exists]), [[at('tools'), 'custom', true]]);
  const top = path.parse(root).root;
  assert.deepEqual(await studio.setCustomPath([top]), [top], 'a root stays as it is');
  await studio.setCustomPath([at('missing')]);
  assert.deepEqual((await studio.pathEntries()).slice(-1).map((entry) => [entry.source, entry.exists]), [['custom', false]]);
  await studio.setCustomPath([]);
  assert.equal((await studio.pathEntries()).some((entry) => entry.source === 'custom'), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The .clang-format a file follows, for the editor's indentation and format on save.

// The predefined styles' values, and the file's own on top.
assert.deepEqual(parseStyle(''), { useTab: false, indentWidth: 2, tabWidth: 8, columnLimit: 80, disabled: false });
assert.deepEqual(parseStyle('BasedOnStyle: Microsoft'), { useTab: false, indentWidth: 4, tabWidth: 4, columnLimit: 120, disabled: false });
assert.deepEqual(parseStyle([
  '# Glist style',
  'BasedOnStyle: WebKit',
  'UseTab: ForIndentation   # tabs, aligned with spaces',
  'IndentWidth: 4',
  "TabWidth: '4'",
  'BraceWrapping:',
  '  AfterClass: true',
  '  IndentWidth: 9',
].join('\n')), { useTab: true, indentWidth: 4, tabWidth: 4, columnLimit: 0, disabled: false });
assert.equal(parseStyle('UseTab: Never').useTab, false);
assert.equal(parseStyle('UseTab: false').useTab, false);
assert.equal(parseStyle('UseTab: Always').useTab, true);
assert.equal(parseStyle('DisableFormat: true').disabled, true);
// One document for every language, and C++'s own on top; others are not C++'s.
assert.deepEqual(parseStyle([
  'IndentWidth: 3', '---', 'Language: JavaScript', 'IndentWidth: 7', '---', 'Language: Cpp', 'ColumnLimit: 100', '...',
].join('\n')), { useTab: false, indentWidth: 3, tabWidth: 8, columnLimit: 100, disabled: false });

const styleRoot = mkdtempSync(path.join(tmpdir(), 'glist-style-'));
try {
  const place = (relative, contents) => {
    mkdirSync(path.dirname(path.join(styleRoot, relative)), { recursive: true });
    writeFileSync(path.join(styleRoot, relative), contents);
  };
  place('App/.clang-format', 'BasedOnStyle: LLVM\nUseTab: Always\nIndentWidth: 4\nTabWidth: 4\nColumnLimit: 100\n');
  place('App/src/gCanvas.cpp', '');
  place('App/src/third/_clang-format', 'BasedOnStyle: InheritParentConfig\nColumnLimit: 70\n');
  place('App/src/third/lib.h', '');
  // The nearest one counts, from the file's own folder up.
  assert.deepEqual(await codeStyleFor(path.join(styleRoot, 'App', 'src', 'gCanvas.cpp')), {
    file: path.join(styleRoot, 'App', '.clang-format'), useTab: true, indentWidth: 4, tabWidth: 4, columnLimit: 100, disabled: false,
  });
  // InheritParentConfig starts from the one further up.
  assert.deepEqual(await codeStyleFor(path.join(styleRoot, 'App', 'src', 'third', 'lib.h')), {
    file: path.join(styleRoot, 'App', 'src', 'third', '_clang-format'), useTab: true, indentWidth: 4, tabWidth: 4, columnLimit: 70, disabled: false,
  });
  place('Other/main.cpp', '');
  const outside = await codeStyleFor(path.join(styleRoot, 'Other', 'main.cpp'));
  // None above it here, unless the machine has one further up.
  assert.ok(outside === null || !outside.file.startsWith(styleRoot));
} finally {
  rmSync(styleRoot, { recursive: true, force: true });
}

console.log('Studio file tests passed.');
