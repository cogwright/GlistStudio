import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeStudio, openProjectAt, pluginDllFolders, studio } from '../src/studio.ts';

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
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Studio file tests passed.');
