import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGitService } from '../src/git-service.ts';

// The Git service against a project made for the test and a remote beside it.
// Run with jiti, which resolves the service's own imports.
const root = mkdtempSync(path.join(tmpdir(), 'glist-git-service-'));
// Global settings, such as the identity Settings writes, stay in the test's
// folder, and git makes up no name or email of its own.
Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1' });
['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'].forEach((key) => delete process.env[key]);
writeFileSync(path.join(root, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n');
const projects = path.join(root, 'projects');
const project = path.join(projects, 'MyApp');
const trash = path.join(root, 'trash');
mkdirSync(project, { recursive: true });
mkdirSync(trash);
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
  writeFileSync(path.join(project, file), text);
};
const read = (file) => readFileSync(path.join(project, file), 'utf8');
const inProject = (file) => path.join(project, file);

let openRoot = project;
const consoleLines = [];
const service = createGitService({
  projectRoot: () => openRoot,
  environment: () => ({ ...process.env }),
  send: (channel, payload) => { if (channel === 'git:console') consoleLines.push(payload); },
  trash: async (file) => renameSync(file, path.join(trash, path.basename(file))),
  home: () => path.join(root, 'GlistStudio'),
  projectsDirectory: () => projects,
  language: () => 'en',
});
const git = service.handlers;
const run = async (action) => {
  const result = await git.gitRun(action);
  assert.equal(result.success, true, `${action.kind}: ${result.message}`);
  return result;
};
const changes = async () => Object.fromEntries((await git.gitStatus()).repository.changes.map((change) => [path.relative(project, change.path), change.state]));

try {
  // Not a repository yet; making one ignores the build folder from the start.
  write('src/main.cpp', 'int main() {\n  return 0;\n}\n');
  write('_build/Release/MyApp', 'binary');
  let status = await git.gitStatus();
  assert.match(status.version, /^\d+\.\d+/);
  assert.equal(status.repository, null);
  await run({ kind: 'init' });
  assert.match(read('.gitignore'), /^_build\/$/m);
  status = await git.gitStatus();
  assert.equal(status.repository.branch, 'main');
  assert.equal(status.repository.head, null);
  assert.equal(realpathSync(status.repository.root), realpathSync(project));
  assert.deepEqual(await changes(), { '.gitignore': 'untracked', 'src/main.cpp': 'untracked' });
  assert.deepEqual(status.repository.ignored, [inProject('_build') + path.sep]);

  // Committing needs a name and an email.
  let result = await git.gitRun({ kind: 'commit', message: 'First', paths: [inProject('src/main.cpp')], amend: false });
  assert.equal(result.success, false);
  assert.match(result.message, /name and email/);
  await run({ kind: 'identity', name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(await git.gitIdentity(), { name: 'Ada Lovelace', email: 'ada@example.com' });

  // Only the chosen files are committed.
  await run({ kind: 'commit', message: 'First', paths: [inProject('src/main.cpp')], amend: false });
  assert.deepEqual(await changes(), { '.gitignore': 'untracked' });
  await run({ kind: 'commit', message: 'Ignore the build', paths: [inProject('.gitignore')], amend: false });
  await run({ kind: 'commit', message: 'Ignore built files', paths: [], amend: true });
  assert.equal(await git.gitLastMessage(), 'Ignore built files');
  assert.deepEqual((await git.gitLog({})).map((commit) => commit.subject), ['Ignore built files', 'First']);
  result = await git.gitRun({ kind: 'commit', message: 'Nothing', paths: [], amend: false });
  assert.equal(result.success, false);

  // Rolling back puts tracked files back and moves new ones to the trash.
  write('src/main.cpp', 'int main() {\n  return 1;\n}\n');
  write('src/Extra.h', '#pragma once\n');
  write('src/Other.h', '// untracked\n');
  execFileSync('git', ['add', 'src/Extra.h'], { cwd: project });
  assert.deepEqual(await changes(), { 'src/main.cpp': 'modified', 'src/Extra.h': 'added', 'src/Other.h': 'untracked' });
  await run({ kind: 'rollback', paths: [inProject('src/main.cpp'), inProject('src/Extra.h'), inProject('src/Other.h')] });
  assert.equal(read('src/main.cpp'), 'int main() {\n  return 0;\n}\n');
  assert.ok(!existsSync(inProject('src/Extra.h')));
  assert.ok(existsSync(path.join(trash, 'Extra.h')));
  assert.deepEqual(await changes(), { 'src/Other.h': 'untracked' });
  await run({ kind: 'ignore', paths: [inProject('src/Other.h')] });
  assert.match(read('.gitignore'), /^\/src\/Other\.h$/m);
  assert.deepEqual(await changes(), { '.gitignore': 'modified' });
  await run({ kind: 'rollback', paths: [inProject('.gitignore')] });

  // Versions of files, blame and commit details.
  const [latest, first] = await git.gitLog({});
  assert.equal((await git.gitFileAt(first.hash, inProject('src/main.cpp'))).text, 'int main() {\n  return 0;\n}\n');
  assert.equal((await git.gitFileAt(first.hash, inProject('.gitignore'))).text, null);
  const details = await git.gitCommitDetails(latest.hash);
  assert.equal(details.base, first.hash);
  assert.deepEqual(details.files, [{ path: inProject('.gitignore'), state: 'added' }]);
  assert.equal((await git.gitCommitDetails(first.hash)).base, null);
  const blame = await git.gitBlame(inProject('src/main.cpp'), 'int main() {\n  return 5;\n}\n');
  assert.deepEqual(blame.map((line) => line.uncommitted), [false, true, false]);
  await assert.rejects(git.gitFileAt('--output=x', inProject('src/main.cpp')));
  await assert.rejects(git.gitFileAt('HEAD', path.join(root, 'elsewhere.txt')));

  // Branches: a conflict while merging, resolved by keeping one side.
  await run({ kind: 'create-branch', name: 'feature', checkout: true });
  write('src/main.cpp', 'int main() {\n  return 2;\n}\n');
  await run({ kind: 'commit', message: 'Return two', paths: [inProject('src/main.cpp')], amend: false });
  await run({ kind: 'checkout', ref: 'main' });
  write('src/main.cpp', 'int main() {\n  return 3;\n}\n');
  await run({ kind: 'commit', message: 'Return three', paths: [inProject('src/main.cpp')], amend: false });
  result = await git.gitRun({ kind: 'merge', ref: 'feature' });
  assert.equal(result.conflicts, true);
  status = await git.gitStatus();
  assert.equal(status.repository.operation, 'merge');
  assert.match(status.repository.operationSubject, /feature/);
  assert.deepEqual(status.repository.changes.filter((change) => change.conflict).map((change) => [path.relative(project, change.path), change.conflict]),
    [[path.join('src', 'main.cpp'), 'UU']]);
  await run({ kind: 'resolve', path: inProject('src/main.cpp'), side: 'theirs' });
  assert.equal(read('src/main.cpp'), 'int main() {\n  return 2;\n}\n');
  // Taken back, the conflict and its markers return.
  await run({ kind: 'unresolve', path: inProject('src/main.cpp') });
  assert.match(read('src/main.cpp'), /^<<<<<<< ours$/m);
  assert.equal((await changes())[path.join('src', 'main.cpp')], 'conflict');
  await run({ kind: 'resolve', path: inProject('src/main.cpp'), side: 'mine' });
  assert.equal(read('src/main.cpp'), 'int main() {\n  return 3;\n}\n');
  await run({ kind: 'unresolve', path: inProject('src/main.cpp') });
  await run({ kind: 'resolve', path: inProject('src/main.cpp'), side: 'theirs' });
  await run({ kind: 'commit', message: 'Merge feature', paths: [], amend: false });
  status = await git.gitStatus();
  assert.equal(status.repository.operation, null);
  assert.equal((await git.gitLog({ limit: 1 }))[0].parents.length, 2);
  assert.deepEqual((await git.gitBranches()).map((branch) => [branch.name, branch.current]).sort(), [['feature', false], ['main', true]]);
  result = await git.gitRun({ kind: 'create-branch', name: 'bad name', checkout: false });
  assert.equal(result.success, false);
  result = await git.gitRun({ kind: 'checkout', ref: '--orphan' });
  assert.equal(result.success, false);

  // Checking out over local changes: refused, then done with them stashed and brought back.
  await run({ kind: 'checkout', ref: 'feature' });
  write('src/main.cpp', 'int main() {\n  return 9;\n}\n');
  write('notes.txt', 'mine\n');
  result = await git.gitRun({ kind: 'checkout', ref: 'main' });
  assert.equal(result.success, true);
  await run({ kind: 'checkout', ref: 'feature' });
  execFileSync('git', ['commit', '-qam', 'On feature'], { cwd: project });
  await run({ kind: 'checkout', ref: 'main' });
  write('src/main.cpp', 'int main() {\n  return 10;\n}\n');
  result = await git.gitRun({ kind: 'checkout', ref: 'feature' });
  assert.equal(result.localChanges, true);
  result = await git.gitRun({ kind: 'checkout', ref: 'feature', smart: true });
  assert.equal(result.conflicts, true);
  status = await git.gitStatus();
  assert.equal(status.repository.branch, 'feature');
  await run({ kind: 'resolve', path: inProject('src/main.cpp'), side: 'mine' });
  assert.equal(read('src/main.cpp'), 'int main() {\n  return 10;\n}\n');
  await run({ kind: 'rollback', paths: [inProject('src/main.cpp')] });
  assert.equal((await git.gitStashes()).length, 1);
  await run({ kind: 'drop-stash', name: 'stash@{0}' });

  // Stashes.
  await run({ kind: 'checkout', ref: 'main' });
  write('src/main.cpp', 'stashed\n');
  await run({ kind: 'stash', message: 'Try something', untracked: true });
  assert.deepEqual(await changes(), {});
  assert.equal((await git.gitStatus()).repository.stashes, 1);
  const [stash] = await git.gitStashes();
  assert.equal(stash.message, 'On main: Try something');
  assert.deepEqual((await git.gitCommitDetails(stash.name)).files.map((file) => path.relative(project, file.path)), ['src/main.cpp']);
  await run({ kind: 'unstash', name: stash.name, pop: true });
  assert.equal(read('src/main.cpp'), 'stashed\n');
  assert.equal(read('notes.txt'), 'mine\n');
  await run({ kind: 'rollback', paths: [inProject('src/main.cpp')] });

  // A remote: pushing sets the upstream, and a clone gets what was pushed.
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  let outgoing = await git.gitOutgoing();
  assert.equal(outgoing.remote, null);
  result = await git.gitRun({ kind: 'push' });
  assert.equal(result.success, false);
  await run({ kind: 'add-remote', name: 'origin', url: remote });
  result = await git.gitRun({ kind: 'add-remote', name: 'evil', url: '--upload-pack=touch /tmp/x' });
  assert.equal(result.success, false);
  assert.deepEqual((await git.gitRemotes()).map((entry) => entry.name), ['origin']);
  outgoing = await git.gitOutgoing();
  assert.equal(outgoing.remote, 'origin');
  assert.equal(outgoing.branch, 'main');
  assert.ok(outgoing.commits.length >= 4);
  await run({ kind: 'push' });
  status = await git.gitStatus();
  assert.equal(status.repository.upstream, 'origin/main');
  assert.equal((await git.gitOutgoing()).commits.length, 0);
  await run({ kind: 'create-tag', name: 'v1', message: 'Version one' });
  await run({ kind: 'push', tags: true });
  assert.deepEqual((await git.gitTags()).map((tag) => tag.name), ['v1']);

  const cloned = await git.gitClone(remote, 'Copy');
  assert.equal(cloned.success, true, cloned.message);
  assert.equal(cloned.root, path.join(projects, 'Copy'));
  assert.equal(readFileSync(path.join(projects, 'Copy', 'src', 'main.cpp'), 'utf8'), 'int main() {\n  return 2;\n}\n');
  assert.match((await git.gitClone(remote, 'Copy')).message, /already exists/);
  assert.equal((await git.gitClone('--upload-pack=touch /tmp/x', 'Other')).success, false);

  // Someone else pushes; Update Project brings it in, with local changes kept.
  execFileSync('git', ['-C', path.join(projects, 'Copy'), 'commit', '-q', '--allow-empty', '-m', 'From the copy']);
  execFileSync('git', ['-C', path.join(projects, 'Copy'), 'push', '-q']);
  write('notes.txt', 'still mine\n');
  await run({ kind: 'fetch' });
  status = await git.gitStatus();
  assert.equal(status.repository.behind, 1);
  write('src/main.cpp', 'local edit\n');
  await run({ kind: 'pull', rebase: false });
  status = await git.gitStatus();
  assert.equal(status.repository.behind, 0);
  assert.equal(read('src/main.cpp'), 'local edit\n');
  assert.equal((await git.gitLog({ text: 'from the COPY' }))[0].subject, 'From the copy');
  assert.equal((await git.gitLog({ text: latest.hash.slice(0, 8) }))[0].hash, latest.hash);
  assert.ok((await git.gitLog({ path: inProject('src/main.cpp') })).every((commit) => commit.subject !== 'Ignore built files'));

  // Rebasing with changes not committed yet keeps them.
  await run({ kind: 'create-branch', name: 'side', checkout: true });
  write('notes.txt', 'side notes\n');
  await run({ kind: 'commit', message: 'Side notes', paths: [inProject('notes.txt')], amend: false });
  await run({ kind: 'checkout', ref: 'main' });
  write('src/main.cpp', 'kept while rebasing\n');
  await run({ kind: 'rebase', onto: 'side' });
  assert.equal(read('src/main.cpp'), 'kept while rebasing\n');
  assert.equal(read('notes.txt'), 'side notes\n');

  // The console shows the commands that change the repository.
  assert.ok(consoleLines.some((entry) => entry.kind === 'command' && entry.text.startsWith('git commit -m First')));

  // Another project is not a repository.
  openRoot = path.join(root, 'plain');
  mkdirSync(openRoot);
  assert.equal((await git.gitStatus()).repository, null);
} finally {
  service.stop();
  rmSync(root, { recursive: true, force: true });
}

console.log('Git service tests passed.');
