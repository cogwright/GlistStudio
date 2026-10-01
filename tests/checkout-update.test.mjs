import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCheckouts, gitRunner, isSourceAddress } from '../src/checkout-update.ts';
import { toolLanguage } from '../src/tool-language.ts';

// Updating a copy of the engine from GlistEngine, against bare repositories
// standing in for GitHub: the source, and a student's fork of it. Run with jiti.
const root = mkdtempSync(path.join(tmpdir(), 'glist-checkout-'));
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
});
writeFileSync(path.join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const site = path.join(root, 'site');
const source = path.join(site, 'GlistEngine', 'GlistEngine.git');
const fork = path.join(site, 'student', 'GlistEngine.git');
mkdirSync(path.dirname(source), { recursive: true });
execFileSync('git', ['init', '-q', '--bare', source]);
const author = path.join(root, 'author');
execFileSync('git', ['clone', '-q', source, author], { stdio: 'ignore' });
const publish = (file, text, message) => {
  writeFileSync(path.join(author, file), text);
  git(author, 'add', '.');
  git(author, 'commit', '-q', '-m', message);
  git(author, 'push', '-q', 'origin', 'HEAD:main');
};
publish('gCore.h', 'core 1\n', 'Core one');
publish('gApp.h', 'app 1\n', 'App one');
mkdirSync(path.dirname(fork), { recursive: true });
execFileSync('git', ['clone', '-q', '--bare', source, fork]);

// The student's copy: origin is their fork, GlistEngine is upstream.
const copy = path.join(root, 'GlistEngine');
execFileSync('git', ['clone', '-q', fork, copy], { stdio: 'ignore' });
git(copy, 'remote', 'add', 'upstream', source);
const read = (file) => readFileSync(path.join(copy, file), 'utf8');
const commit = (file, text, message) => {
  writeFileSync(path.join(copy, file), text);
  git(copy, 'add', '.');
  git(copy, 'commit', '-q', '-m', message);
};

let protection = true;
const checkouts = createCheckouts({
  git: gitRunner(() => process.env),
  site,
  isProtected: async (_folder, _remote, branch) => protection && ['main', 'master'].includes(branch),
  language: () => 'en',
});
const inspect = (fetch = true) => checkouts.inspect(copy, 'GlistEngine/GlistEngine', { fetch });
const update = (choice, resolve) => checkouts.update(copy, 'GlistEngine', 'GlistEngine/GlistEngine', choice, { resolve });
const subjects = () => git(copy, 'log', '--format=%s', '--first-parent', 'HEAD').split('\n');

try {
  // Addresses: GitHub in the forms git takes, or the site; nothing else.
  assert.equal(isSourceAddress('git@github.com:GlistEngine/GlistEngine.git', 'GlistEngine/GlistEngine'), true);
  assert.equal(isSourceAddress('https://github.com/glistengine/glistengine', 'GlistEngine/GlistEngine'), true);
  assert.equal(isSourceAddress('https://github.com/student/GlistEngine.git', 'GlistEngine/GlistEngine'), false);
  assert.equal(isSourceAddress(`${source}/`, 'GlistEngine/GlistEngine', site), true);

  // The source is found under upstream, not origin, and nothing is new yet.
  let state = await inspect();
  assert.deepEqual([state.remote, state.branch, state.defaultBranch, state.behind, state.ahead, state.changed], ['upstream', 'main', 'main', 0, 0, 0]);
  assert.equal(state.head.subject, 'App one');
  assert.deepEqual(await update(), { success: true, message: 'GlistEngine', upToDate: true });

  // New commits and nothing of the student's own: a fast-forward, no questions.
  publish('gCore.h', 'core 2\n', 'Core two');
  state = await inspect();
  assert.deepEqual([state.behind, state.keepBy, state.incoming.map((entry) => entry.subject)], [1, 'fast-forward', ['Core two']]);
  let result = await update();
  assert.deepEqual([result.success, result.how], [true, 'fast-forward']);
  assert.equal(read('gCore.h'), 'core 2\n');

  // A changed file: it asks, then keeping puts the file back after.
  publish('gCore.h', 'core 3\n', 'Core three');
  writeFileSync(path.join(copy, 'gApp.h'), 'app mine\n');
  result = await update();
  assert.deepEqual(result.confirm, { changed: 1, ahead: 0, keepBy: 'fast-forward' });
  assert.equal(read('gApp.h'), 'app mine\n', 'nothing changed before the answer');
  result = await update('keep');
  assert.deepEqual([result.success, result.how, result.stashClash], [true, 'fast-forward', undefined]);
  assert.deepEqual([read('gCore.h'), read('gApp.h')], ['core 3\n', 'app mine\n']);
  git(copy, 'checkout', '--', 'gApp.h');

  // A commit of the student's own, not pushed anywhere: it goes on top of the new ones.
  commit('gMine.h', 'mine\n', 'Mine');
  publish('gCore.h', 'core 4\n', 'Core four');
  state = await inspect();
  assert.deepEqual([state.ahead, state.behind, state.keepBy, state.pushedTo], [1, 1, 'rebase', undefined]);
  result = await update('keep');
  assert.deepEqual([result.success, result.how], [true, 'rebase'], result.message);
  assert.deepEqual(subjects().slice(0, 2), ['Mine', 'Core four'], 'rebased, in a line');

  // Pushed to the fork's main, which is protected: merged, so the fork takes a plain push.
  git(copy, 'push', '-q', 'origin', 'HEAD:main');
  publish('gCore.h', 'core 5\n', 'Core five');
  state = await inspect();
  assert.deepEqual([state.keepBy, state.pushedTo], ['merge', 'origin/main']);
  result = await update('keep');
  assert.deepEqual([result.success, result.how], [true, 'merge'], result.message);
  assert.match(subjects()[0], /^Merge /, 'a merge commit on top');
  assert.equal(git(copy, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD') === '', true, 'the fork only moves forward');
  assert.equal(read('gCore.h'), 'core 5\n');
  git(copy, 'push', '-q', 'origin', 'HEAD:main');

  // With protection off, even pushed commits go on top.
  commit('gMine2.h', 'mine 2\n', 'Mine two');
  git(copy, 'push', '-q', 'origin', 'HEAD:main');
  publish('gApp.h', 'app 2\n', 'App two');
  protection = false;
  assert.deepEqual([(await inspect()).keepBy, (await inspect()).pushedTo], ['rebase', 'origin/main']);
  protection = true;
  assert.equal((await inspect()).keepBy, 'merge');

  // Replacing: the commits stay on a branch, the changed files in a stash, and the copy is the source's.
  writeFileSync(path.join(copy, 'gCore.h'), 'core edited\n');
  const before = git(copy, 'rev-parse', 'HEAD');
  result = await update('replace');
  assert.deepEqual([result.success, result.how], [true, 'replace'], result.message);
  assert.match(result.kept.branch, /^glist-studio\/kept-\d{8}-\d{6}$/);
  assert.equal(git(copy, 'rev-parse', result.kept.branch), before);
  assert.match(git(copy, 'stash', 'list'), /kept before updating GlistEngine/);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), git(copy, 'rev-parse', 'upstream/main'));
  assert.equal(existsSync(path.join(copy, 'gMine.h')), false);
  git(copy, 'stash', 'drop', '-q');

  // A conflict takes the update back: the copy, its commit and its changed file are as they were.
  commit('gCore.h', 'core mine\n', 'Core mine');
  writeFileSync(path.join(copy, 'gApp.h'), 'app edited\n');
  publish('gCore.h', 'core 6\n', 'Core six');
  const head = git(copy, 'rev-parse', 'HEAD');
  result = await update('keep');
  assert.deepEqual([result.success, result.conflicts, result.how], [false, true, 'rebase']);
  assert.match(result.message, /conflict with the new ones from GlistEngine\/GlistEngine/);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), head);
  assert.deepEqual([read('gCore.h'), read('gApp.h')], ['core mine\n', 'app edited\n']);
  assert.equal(git(copy, 'status', '--porcelain'), 'M gApp.h');
  assert.equal(git(copy, 'stash', 'list'), '', 'the changed file is not left in a stash');
  // Asked to resolve, the conflict stays for the Git tools.
  result = await update('keep', true);
  assert.deepEqual([result.success, result.conflicts, result.kept], [false, true, { stash: 'Glist Studio: kept while updating GlistEngine' }]);
  assert.match(git(copy, 'status'), /rebase in progress/);
  git(copy, 'rebase', '--abort');
  // The changed file waits in the stash, as the notice says, until it is applied.
  git(copy, 'stash', 'pop', '-q');
  assert.equal(read('gApp.h'), 'app edited\n');

  // A changed file that clashes with the new version: updated, and the file waits in a stash.
  git(copy, 'reset', '-q', '--hard', 'upstream/main');
  writeFileSync(path.join(copy, 'gCore.h'), 'core clash\n');
  publish('gCore.h', 'core 7\n', 'Core seven');
  result = await update('keep');
  assert.deepEqual([result.success, result.how, result.stashClash], [true, 'fast-forward', true], result.message);
  assert.equal(git(copy, 'rev-parse', 'HEAD'), git(copy, 'rev-parse', 'upstream/main'));
  assert.match(git(copy, 'stash', 'list'), /kept while updating GlistEngine/);
  // Both sides are in the file, marked, as git's own autostash leaves them.
  assert.match(read('gCore.h'), /<<<<<<<[\s\S]*core 7[\s\S]*core clash[\s\S]*>>>>>>>/);

  // A new file of the user's that the new version brings too. Git's own
  // --autostash leaves new files in place and stops with "Aborting"; here the
  // update goes on and the user's file waits in a stash.
  git(copy, 'reset', '-q', '--hard', 'upstream/main');
  git(copy, 'stash', 'clear');
  writeFileSync(path.join(copy, 'gNew.h'), 'new mine\n');
  publish('gNew.h', 'new theirs\n', 'New header');
  result = await update();
  assert.deepEqual(result.confirm, { changed: 1, ahead: 0, keepBy: 'fast-forward' });
  result = await update('keep');
  assert.deepEqual([result.success, result.how, result.stashClash], [true, 'fast-forward', true], result.message);
  assert.equal(read('gNew.h'), 'new theirs\n');
  assert.match(git(copy, 'stash', 'list'), /kept while updating GlistEngine/);
  assert.equal(git(copy, 'show', 'stash@{0}^3:gNew.h'), 'new mine');

  // New files the new version does not bring come back where they were, and no stash is left.
  git(copy, 'stash', 'clear');
  writeFileSync(path.join(copy, 'notes.txt'), 'my notes\n');
  writeFileSync(path.join(copy, 'gApp.h'), 'app mine again\n');
  publish('gCore.h', 'core 8\n', 'Core eight');
  result = await update('keep');
  assert.deepEqual([result.success, result.how, result.stashClash], [true, 'fast-forward', undefined], result.message);
  assert.deepEqual([read('notes.txt'), read('gApp.h'), read('gCore.h')], ['my notes\n', 'app mine again\n', 'core 8\n']);
  assert.equal(git(copy, 'stash', 'list'), '');

  // What changes the copy is shown in the Git console, with the folder, and what git said.
  const shown = [];
  const logged = createCheckouts({
    git: gitRunner(() => process.env, (entry) => shown.push(entry)), site, isProtected: async () => true, language: () => 'en',
  });
  publish('gCore.h', 'core 9\n', 'Core nine');
  await logged.inspect(copy, 'GlistEngine/GlistEngine', { fetch: true });
  assert.equal(shown.length, 0, 'a check asks quietly');
  result = await logged.update(copy, 'GlistEngine', 'GlistEngine/GlistEngine', 'keep');
  assert.equal(result.success, true, result.message);
  const commands = shown.filter((entry) => entry.kind === 'command').map((entry) => entry.text);
  assert.deepEqual(commands, [
    'git -C GlistEngine fetch --quiet upstream main',
    'git -C GlistEngine stash push --include-untracked --message "Glist Studio: kept while updating GlistEngine"',
    'git -C GlistEngine merge --ff-only refs/remotes/upstream/main',
    'git -C GlistEngine stash pop',
  ]);
  assert.ok(shown.some((entry) => entry.kind === 'output' && /Fast-forward/.test(entry.text)));
  git(copy, 'checkout', '-q', '--', '.');
  git(copy, 'clean', '-q', '-f');

  // Where it is not updated: another branch, a commit, no remote that is the source.
  git(copy, 'checkout', '-q', '-f', '-b', 'experiment');
  assert.match((await update()).message, /GlistEngine is on the branch experiment; updates are for main/);
  git(copy, 'checkout', '-q', '--detach', 'main');
  assert.match((await update()).message, /on a commit rather than a branch/);
  git(copy, 'checkout', '-q', 'main');
  git(copy, 'remote', 'remove', 'upstream');
  assert.equal((await inspect()).remote, null);
  assert.match((await update()).message, /none of its remotes is GlistEngine\/GlistEngine/);
  assert.deepEqual(await checkouts.inspect(path.join(root, 'nothing'), 'GlistEngine/GlistEngine'), { repository: false });
} finally {
  rmSync(root, { recursive: true, force: true });
}

// What git, GCC and make are given to answer in the editor's language: with no locale, one the
// system has (Linux's C.UTF-8 gives git and GCC their Turkish where en_US.UTF-8
// may be missing; macOS's gettext takes C.UTF-8 for plain C), in UTF-8.
assert.deepEqual(toolLanguage('tr', {}, 'darwin'), { LANGUAGE: 'tr', LC_MESSAGES: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' });
assert.deepEqual(toolLanguage('tr', {}, 'linux'), { LANGUAGE: 'tr', LC_MESSAGES: 'C.UTF-8', LC_CTYPE: 'C.UTF-8' });
assert.deepEqual(toolLanguage('fr', { LANG: 'C.UTF-8' }, 'darwin'), { LANGUAGE: 'fr', LC_MESSAGES: 'en_US.UTF-8' });
assert.deepEqual(toolLanguage('tr', { LANG: 'tr_TR.UTF-8' }, 'linux'), { LANGUAGE: 'tr' }, 'a system locale is kept');
assert.deepEqual(toolLanguage('en', { LANG: 'de_DE.ISO8859-1' }, 'linux'), { LANGUAGE: 'en', LC_CTYPE: 'C.UTF-8' }, 'written in UTF-8');
assert.deepEqual(toolLanguage('tr', {}, 'win32'), { LANGUAGE: 'tr', LC_MESSAGES: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' });

console.log('Checkout update tests passed.');
