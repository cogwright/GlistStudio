import assert from 'node:assert/strict';
import { errorMessage, formatReport, ignorableError, redactSettings, redactText } from '../src/debug-report.ts';

// The debug report: what it hides, what it keeps, and how it reads. Run with jiti.

const home = '/Users/ada';
const commit = '0123456789abcdef0123456789abcdef01234567';

// The home folder is ~, in paths and file addresses, but not in a longer name that starts the same.
assert.equal(redactText('/Users/ada/dev/glist/myglistapps/App', home), '~/dev/glist/myglistapps/App');
assert.equal(redactText('at file:///Users/ada/work/index.js:2:10', home), 'at file://~/work/index.js:2:10');
assert.equal(redactText('/Users/adam/dev and /Users/ada', home), '/Users/adam/dev and ~');
// Windows: either slash, any case, and spaces as a file address writes them.
assert.equal(redactText('C:\\Users\\Ada Lovelace\\dev\\glist', 'C:\\Users\\Ada Lovelace'), '~\\dev\\glist');
assert.equal(redactText('file:///c:/users/ada%20lovelace/x.js', 'C:\\Users\\Ada Lovelace'), 'file:///~/x.js');
// Git's name and email, wherever they are; mail addresses, but not git's SSH user.
assert.equal(redactText('Author: Ada Lovelace <ada@example.org>', home, ['Ada Lovelace', 'ada@example.org']), 'Author: [hidden] <[hidden]>');
assert.equal(redactText('committed by Ada Lovelace today', home, ['Ada Lovelace']), 'committed by [hidden] today');
assert.equal(redactText('mail someone@school.edu.tr', home), 'mail [hidden]');
assert.equal(redactText('git@github.com:GlistEngine/GlistEngine.git', home), 'git@github.com:GlistEngine/GlistEngine.git');
assert.equal(redactText('monaco-editor@0.56.0', home), 'monaco-editor@0.56.0');
// Who signs in to a server and with what.
assert.equal(redactText('https://ada:s3cret@github.com/a/b.git', home), 'https://[hidden]@github.com/a/b.git');
assert.equal(redactText('ssh://git@github.com/a/b.git', home), 'ssh://git@github.com/a/b.git');
// Tokens by their shape, and values whose names say they are secret.
assert.equal(redactText('push with ghp_abcdefghijklmnopqrstuvwxyz0123456789', home), 'push with [hidden]');
assert.equal(redactText('Authorization: Bearer abc.def.ghi-123', home), 'Authorization: [hidden] [hidden]');
assert.equal(redactText('GITHUB_TOKEN=abc123 password: hunter2 ?token=xyz&x=1', home), 'GITHUB_TOKEN=[hidden] password: [hidden] ?token=[hidden]&x=1');
assert.equal(redactText('at git-auth.ts:12:5', home), 'at git-auth.ts:12:5');
assert.equal(redactText('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', home), '[hidden]');
// Long runs of letters and digits are keys, but a commit's id is kept, and so are long plain words.
assert.equal(redactText('key Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg== end', home), 'key [hidden] end');
assert.equal(redactText(`commit ${commit}`, home), `commit ${commit}`);
assert.equal(redactText('BackendRestartedNotificationHandlerFactory', home), 'BackendRestartedNotificationHandlerFactory');

// Settings: by name without glist-studio-; what was typed only by length; the bulky only by size;
// environment values and Find in Files' search hidden; paths with ~; other storage left out.
const scrub = (text) => redactText(text, home, ['ada@example.org']);
const settings = new Map(redactSettings([
  ['glist-studio-theme', 'dark-modern'],
  ['glist-studio-commit-message:/Users/ada/App', 'fix the jump'],
  ['glist-studio-run-arguments:/Users/ada/App', '--key secret'],
  ['glist-studio-session:/Users/ada/App', '{"groups":[]}'],
  ['glist-studio-environment', JSON.stringify([{ name: 'CC', value: '/usr/bin/clang' }, { name: 'API_TOKEN', value: 'abc' }])],
  ['glist-studio-find-in-files', JSON.stringify({ text: 'my search', matchCase: true })],
  ['glist-studio-custom-path', JSON.stringify(['/Users/ada/bin'])],
  ['glist-studio-git-protection', JSON.stringify({ on: true, branches: ['main'], authToken: 'x' })],
  ['glist-studio-note', 'ask ada@example.org'],
  ['other-app', 'kept out'],
], scrub));
assert.deepEqual([...settings.keys()], [
  'commit-message:~/App', 'custom-path', 'environment', 'find-in-files', 'git-protection', 'note', 'run-arguments:~/App', 'session:~/App', 'theme',
]);
assert.equal(settings.get('theme'), 'dark-modern');
assert.equal(settings.get('commit-message:~/App'), '[hidden] (12 characters)');
assert.equal(settings.get('run-arguments:~/App'), '[hidden] (12 characters)');
assert.equal(settings.get('session:~/App'), 'left out (13 characters)');
assert.equal(settings.get('environment'), '[{"name":"CC","value":"[hidden]"},{"name":"API_TOKEN","value":"[hidden]"}]');
assert.equal(settings.get('find-in-files'), '{"text":"[hidden]","matchCase":true}');
assert.equal(settings.get('custom-path'), '["~/bin"]');
assert.equal(settings.get('git-protection'), '{"on":true,"branches":["main"],"authToken":"[hidden]"}');
assert.equal(settings.get('note'), 'ask [hidden]');
assert.match(redactSettings([['glist-studio-long', 'x'.repeat(500)]], scrub)[0][1], /^x{300}… \(500 characters\)$/);

// Errors that are no fault, and the first line of what is.
const canceled = Object.assign(new Error('Canceled'), { name: 'Canceled' });
assert.ok(ignorableError(canceled, 'Canceled'));
assert.ok(ignorableError(null, 'ResizeObserver loop completed with undelivered notifications.'));
assert.ok(ignorableError(null, 'Script error.'));
assert.ok(ignorableError(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }), 'The user aborted a request.'));
assert.ok(!ignorableError(new Error('boom'), 'boom'));
assert.equal(errorMessage(new Error('boom\n\nError: boom\n    at x (a.js:1:1)')), 'boom');
assert.equal(errorMessage(null, 'Uncaught Error: from the event'), 'Uncaught Error: from the event');
assert.equal(errorMessage('just text'), 'just text');
assert.equal(errorMessage({ source: 'main', message: 'in main' }), 'in main');

// The whole report: sections, name: value lines, the stack in a fenced block, nothing personal.
const app = {
  version: '0.1.0', commit, packaged: true, platform: 'darwin', arch: 'arm64', release: '25.0.0', systemVersion: '26.0',
  versions: { electron: '44.5.1', chrome: '146.0.0.0', node: '24.21.0', v8: '14.6' }, home,
};
const about = {
  version: '0.1.0', head: null, runtime: [],
  repositories: [
    { name: 'GlistEngine', kind: 'engine', location: '~/dev/glist/GlistEngine', found: true, head: { branch: 'main', commit } },
    { name: 'gipWebGL', kind: 'plugin', location: '~/dev/glist/glistplugins/gipWebGL', found: true },
    { name: 'gipGone', kind: 'plugin', location: '~/dev/glist/glistplugins/gipGone', found: false },
  ],
};
const error = new Error("EACCES: permission denied, open '/Users/ada/dev/App/src/main.cpp'");
error.stack = "Error: EACCES: permission denied, open '/Users/ada/dev/App/src/main.cpp'\n    at save (file:///Users/ada/app/index.js:2:100)";
const report = formatReport({
  time: '2026-10-03T12:00:00.000Z', app, about,
  window: { project: '/Users/ada/dev/App', zoom: 125, theme: 'Dark Modern (dark-modern)', language: 'tr' },
  settings: [['glist-studio-theme', 'dark-modern'], ['glist-studio-git', 'on']],
  personal: ['Ada Lovelace', 'ada@example.org'],
  error: { text: 'Save failed', detail: "EACCES: permission denied, open '~/dev/App/src/main.cpp'", error },
});
assert.equal(report, `## Glist Studio debug report

### Error
message: Save failed
detail: EACCES: permission denied, open '~/dev/App/src/main.cpp'
stack:
\`\`\`text
Error: EACCES: permission denied, open '~/dev/App/src/main.cpp'
    at save (file://~/app/index.js:2:100)
\`\`\`

### Glist Studio
version: 0.1.0
commit: ${commit}
build: app, packaged
time: 2026-10-03T12:00:00.000Z

### System
os: macOS 26.0
platform: darwin
arch: arm64
os release: 25.0.0
electron: 44.5.1
chromium: 146.0.0.0
node: 24.21.0
v8: 14.6

### Window
project: ~/dev/App
zoom: 125%
theme: Dark Modern (dark-modern)
language: tr

### Glist Engine and plugins
GlistEngine: main ${commit} (~/dev/glist/GlistEngine)
gipWebGL: not a Git checkout (~/dev/glist/glistplugins/gipWebGL)
gipGone: not found (~/dev/glist/glistplugins/gipGone)

### Settings
git: on
theme: dark-modern
`);

// The browser build: its browser, and the server's system; an error from the main process says
// where; with no answers, what is not known is said, and Help's report has no error at all.
const browser = formatReport({
  time: 't', app: { ...app, packaged: false, systemVersion: null, versions: { node: '22.20.0', v8: '12.4' } },
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/146', about: { ...about, head: { branch: 'agent/x', commit } },
  window: { project: null, zoom: 100, theme: 'Light', language: 'en' }, settings: [], personal: [],
  error: { text: 'Something went wrong', detail: 'in main', error: { source: 'main', message: 'in main' } },
});
assert.match(browser, /\nbranch: agent\/x\nbuild: browser build\n/);
assert.match(browser, /### Browser\nuser agent: Mozilla\/5\.0 \(Macintosh\) Chrome\/146\n\n### Server\nos: macOS\nplatform: darwin\n/);
assert.ok(!/electron:|chromium:/.test(browser));
assert.match(browser, /### Error\nmessage: Something went wrong\ndetail: in main\nwhere: main process\n\n/);
assert.match(browser, /project: none/);
const unknown = formatReport({ time: 't', app: null, about: null, window: { project: null, zoom: 100, theme: '', language: 'en' }, settings: [], personal: [] });
assert.ok(!unknown.includes('### Error'));
assert.match(unknown, /version: unknown\ncommit: unknown\n/);
assert.match(unknown, /### System\nstate: did not answer\n/);
assert.match(unknown, /### Glist Engine and plugins\nstate: the backend did not answer\n/);
assert.match(unknown, /### Settings\nstate: none saved\n$/);

console.log('Debug report tests passed.');
