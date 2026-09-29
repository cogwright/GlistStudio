import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPluginService } from '../src/plugins.ts';

// The Plugins view's backend, against a local server answering as GitHub's
// API and bare repositories standing in for GlistPlugins'. Run with jiti.
const root = mkdtempSync(path.join(tmpdir(), 'glist-plugins-'));
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
writeFileSync(path.join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const workspace = path.join(root, 'glist');
const project = path.join(workspace, 'myglistapps', 'App');
mkdirSync(project, { recursive: true });
writeFileSync(path.join(project, 'CMakeLists.txt'), 'set(PLUGINS)\n');
// Not published by GlistPlugins, and not a repository; and gipDebug, which is never listed.
mkdirSync(path.join(workspace, 'glistplugins', 'gipMine'), { recursive: true });
mkdirSync(path.join(workspace, 'glistplugins', 'gipDebug'), { recursive: true });

// GlistPlugins' gipDemo, and a clone of it where "GlistPlugins" makes new commits.
const site = path.join(root, 'remotes');
const upstream = path.join(site, 'GlistPlugins', 'gipDemo.git');
execFileSync('git', ['init', '-q', '--bare', upstream]);
const author = path.join(root, 'author');
execFileSync('git', ['clone', '-q', upstream, author], { stdio: 'ignore' });
const publish = (text, message) => {
  writeFileSync(path.join(author, 'gipDemo.h'), text);
  git(author, 'add', '.');
  git(author, 'commit', '-q', '-m', message);
  git(author, 'push', '-q', 'origin', 'HEAD:main');
};
publish('// one\n', 'One');

// A plugin published by someone else, listed with GlistPlugins' own.
const extraUpstream = path.join(site, 'someone', 'Extra.git');
execFileSync('git', ['init', '-q', '--bare', extraUpstream]);
const extraAuthor = path.join(root, 'extra-author');
execFileSync('git', ['clone', '-q', extraUpstream, extraAuthor], { stdio: 'ignore' });
const publishExtra = (text, message) => {
  writeFileSync(path.join(extraAuthor, 'Extra.h'), text);
  git(extraAuthor, 'add', '.');
  git(extraAuthor, 'commit', '-q', '-m', message);
  git(extraAuthor, 'push', '-q', 'origin', 'HEAD:main');
};
publishExtra('// extra one\n', 'Extra one');

const server = http.createServer((request, response) => {
  const answers = {
    '/orgs/GlistPlugins/repos': [
      { name: 'gipDemo', full_name: 'GlistPlugins/gipDemo', description: 'A demo', html_url: 'https://github.com/GlistPlugins/gipDemo', default_branch: 'main', archived: false },
      { name: 'gipOld', full_name: 'GlistPlugins/gipOld', description: 'Retired', html_url: 'https://github.com/GlistPlugins/gipOld', default_branch: 'main', archived: true },
      { name: 'gipDebug', full_name: 'GlistPlugins/gipDebug', description: 'GDB for Eclipse', html_url: 'https://github.com/GlistPlugins/gipDebug', default_branch: 'main', archived: false },
    ],
    '/repos/someone/Extra': { name: 'Extra', full_name: 'someone/Extra', description: 'From elsewhere', html_url: 'https://github.com/someone/Extra', default_branch: 'main', archived: false },
  };
  const answer = answers[request.url.split('?')[0]];
  response.writeHead(answer ? 200 : 404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(answer ?? { message: 'Not Found' }));
});
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const service = createPluginService({
  workspace: () => workspace,
  projectCmake: () => path.join(project, 'CMakeLists.txt'),
  environment: () => ({ ...process.env }),
  api: `http://127.0.0.1:${server.address().port}`,
  site,
  extras: ['someone/Extra', 'someone/Missing'],
  language: () => 'en',
});
const find = async (name) => (await service.listPlugins()).plugins.find((plugin) => plugin.name === name);
const plugin = path.join(workspace, 'glistplugins', 'gipDemo');

try {
  // Listed: GlistPlugins' own, not archived ones, and what is installed already.
  let list = await service.listPlugins();
  assert.equal(list.gitFound, true);
  assert.deepEqual(list.plugins.map((entry) => [entry.name, entry.installed, entry.source]), [
    ['Extra', false, 'someone/Extra'], ['gipDemo', false, 'GlistPlugins'], ['gipMine', true, 'GlistPlugins'],
  ], 'gipDebug is never listed, and a listed one that cannot be read is only left out');
  assert.equal((await find('Extra')).description, 'From elsewhere');
  assert.match((await service.installPlugin('gipDebug')).message, /not in the plugin list/);
  assert.equal((await find('gipMine')).official, false);

  // Installing clones into glistplugins; names are checked first.
  assert.match((await service.installPlugin('../escape')).message, /not a plugin name/);
  assert.match((await service.installPlugin('gipOther')).message, /not in the plugin list/);
  assert.equal((await service.installPlugin('gipDemo')).success, true);
  assert.equal(readFileSync(path.join(plugin, 'gipDemo.h'), 'utf8'), '// one\n');
  let demo = await find('gipDemo');
  assert.deepEqual([demo.installed, demo.official, demo.branch, demo.behind, demo.changed], [true, true, 'main', 0, 0]);
  assert.match((await service.installPlugin('gipDemo')).message, /already in glistplugins/);

  // Used in the project, and not.
  assert.equal((await service.usePlugin('gipDemo', true)).success, true);
  assert.equal(readFileSync(path.join(project, 'CMakeLists.txt'), 'utf8'), 'set(PLUGINS gipDemo)\n');
  assert.equal((await find('gipDemo')).used, true);
  await service.usePlugin('gipDemo', false);
  assert.equal(readFileSync(path.join(project, 'CMakeLists.txt'), 'utf8'), 'set(PLUGINS)\n');

  // GlistPlugins moves on: the check sees it, and a clean plugin just follows.
  publish('// two\n', 'Two');
  assert.deepEqual((await service.checkPluginUpdates()).map((entry) => [entry.name, entry.behind]), [['gipDemo', 1]]);
  assert.equal((await service.updatePlugin('gipDemo')).success, true);
  assert.equal(readFileSync(path.join(plugin, 'gipDemo.h'), 'utf8'), '// two\n');

  // With work of the user's own, the update asks first, then keeps it: a stash and a branch.
  publish('// three\n', 'Three');
  writeFileSync(path.join(plugin, 'mine.cpp'), 'int mine;\n');
  git(plugin, 'add', 'mine.cpp');
  git(plugin, 'commit', '-q', '-m', 'Mine');
  writeFileSync(path.join(plugin, 'gipDemo.h'), '// edited\n');
  const asked = await service.updatePlugin('gipDemo');
  assert.deepEqual([asked.success, asked.confirm], [false, { changed: 1, ahead: 1 }]);
  assert.equal(readFileSync(path.join(plugin, 'gipDemo.h'), 'utf8'), '// edited\n', 'nothing changed before the answer');
  const updated = await service.updatePlugin('gipDemo', true);
  assert.equal(updated.success, true, updated.message);
  assert.equal(readFileSync(path.join(plugin, 'gipDemo.h'), 'utf8'), '// three\n');
  assert.equal(existsSync(path.join(plugin, 'mine.cpp')), false);
  assert.match(updated.kept.branch, /^glist-studio\/kept-\d{8}-\d{6}$/);
  assert.equal(git(plugin, 'log', '-1', '--format=%s', updated.kept.branch), 'Mine', 'the commit is on the kept branch');
  assert.match(git(plugin, 'stash', 'list'), /kept before updating gipDemo/);
  assert.equal(git(plugin, 'show', 'stash@{0}:gipDemo.h'), '// edited', 'the edit is in the stash');
  demo = await find('gipDemo');
  assert.deepEqual([demo.behind, demo.ahead, demo.changed], [0, 0, 0]);

  // One from elsewhere installs and updates from its own repository.
  assert.equal((await service.installPlugin('Extra')).success, true);
  const extra = path.join(workspace, 'glistplugins', 'Extra');
  assert.equal(readFileSync(path.join(extra, 'Extra.h'), 'utf8'), '// extra one\n');
  assert.deepEqual([(await find('Extra')).official, (await find('Extra')).behind], [true, 0]);
  publishExtra('// extra two\n', 'Extra two');
  assert.deepEqual((await service.checkPluginUpdates()).map((entry) => entry.name), ['Extra']);
  assert.equal((await service.updatePlugin('Extra')).success, true);
  assert.equal(readFileSync(path.join(extra, 'Extra.h'), 'utf8'), '// extra two\n');
  // Its source is that repository alone, not its owner's others.
  git(extra, 'remote', 'set-url', 'origin', path.join(site, 'someone', 'Other.git'));
  assert.equal((await find('Extra')).official, false);
  assert.match((await service.updatePlugin('Extra')).message, /not installed from someone\/Extra/);

  // Only a plugin on its main branch, from GlistPlugins, is updated.
  git(plugin, 'checkout', '-q', '-b', 'experiment');
  assert.match((await service.updatePlugin('gipDemo')).message, /on the branch experiment; updates are for main/);
  assert.match((await service.updatePlugin('gipMine')).message, /not installed from GlistPlugins/);
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('Plugin tests passed.');
