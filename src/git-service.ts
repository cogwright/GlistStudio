import { spawn } from 'node:child_process';
import { existsSync, promises as fs, statSync, watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  branchFormat, logFormat, parseBlame, parseBranches, parseLog, parseNameStatus, parseRemotes, parseStashes, parseStatus,
  parseTags, stashFormat, tagFormat, type GitFileChange, type GitStatus,
} from './git';
import { isDatabaseSideFile } from './databases';
import { createHostProtection, defaultProtection, matchesBranch, protectionFrom } from './git-protection';
import { languages, type Language, type Words } from './languages';
import { toolLanguage } from './tool-language';

// Git for the Commit view and the Git panel, by running the git program in the
// open project's repository. Anything that changes the repository runs one at
// a time, and is shown in the Git console as the command it ran and what that
// printed. A password a remote asks for is asked for by the system (see
// askpassScript), never typed into the studio.

export interface GitContext {
  // The open project's folder, or null.
  projectRoot(): string | null;
  // The engine and the plugins the open project is built with, which can be repositories of their own.
  dependencies(): Promise<Array<{ name: string; kind: 'engine' | 'plugin'; path: string; exists: boolean }>>;
  // What builds get, with Glist's tools on PATH.
  environment(directory: string): NodeJS.ProcessEnv;
  send(channel: string, payload: unknown): void;
  trash(filePath: string): Promise<void>;
  // Glist Studio's folder, for the password helper.
  home(): string;
  // Where Clone puts a repository.
  projectsDirectory(): string;
  language(): Language;
  // GitHub's API, for the branches it protects; a test server in tests.
  githubApi?: string;
}

type MessageKey = keyof Words['git'];

interface Repository {
  // The folder the studio knows it by: the project's, or the engine's or a plugin's.
  folder: string;
  // That folder with links resolved, as git spells it.
  realFolder: string;
  top: string;
  gitDir: string;
  commonDir: string;
}

interface RunOptions {
  cwd: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  // Shown in the Git console.
  logged?: boolean;
  // Reaches a remote, which may ask for a password.
  remote?: boolean;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  // What was run, for telling why it did not work.
  args: string[];
  // For a command that reached a remote: what git asked its credential helpers.
  credentials?: Credentials;
}

// What git told its credential helpers during a command, by the documented
// protocol (gitcredentials): get when it needs a login, store when the login
// worked, erase when the remote refused it.
interface Credentials {
  asked: boolean;
  accepted: boolean;
  rejected: boolean;
  host: string;
}

// A helper added after any the user has, for the commands Glist Studio runs:
// it answers nothing, so logging in goes on as before, and writes down only
// what git asked and for which host, never a name or password.
export const credentialListener = '!f() { h=; while IFS= read -r l; do case "$l" in host=*) h="${l#host=}";; esac; done; '
  + 'printf "%s %s\\n" "$1" "$h" >> "$GLIST_STUDIO_CREDENTIALS"; }; f';

const text = (result: RunResult): string => result.stdout.toString('utf8');

// A branch, tag, remote or revision as an argument: nothing git could take for an option.
// eslint-disable-next-line no-control-regex
const unsafeName = /^-|[\s\x00-\x1f\x7f~^:?*[\\]|\.\.|@\{/;
const revisionPattern = /^(HEAD|[0-9a-fA-F]{4,64}|stash@\{\d+\})$/;

// What a repository made here ignores from the start: built files, and files the system makes.
const defaultIgnore = '# Built by Glist Studio and CMake\n_build/\n\n# Made by the system\n.DS_Store\nThumbs.db\n';

const askpassPrograms = ['zenity', 'kdialog', 'ssh-askpass', '/usr/lib/ssh/ssh-askpass', '/usr/libexec/openssh/ssh-askpass'];

// Windows has no dialog program a script can call, so PowerShell, which every
// Windows has, shows a form. Git's credential manager asks for HTTPS logins,
// never for an SSH key's passphrase. Git for Windows runs the script with its
// own sh, as it runs ssh; the form goes in encoded, so neither sh nor MSYS's
// path conversion changes it.
export const windowsAskpassScript = (words: Pick<Words['git'], 'askpass' | 'askOk' | 'askCancel'>): string => {
  const text = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const form = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$prompt = if ($env:GLIST_STUDIO_PROMPT) { $env:GLIST_STUDIO_PROMPT } else { ${text(words.askpass)} }
if ($env:SSH_ASKPASS_PROMPT -eq 'confirm') {
  $answer = [System.Windows.Forms.MessageBox]::Show($prompt, 'Git', [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK) { exit 0 } else { exit 1 }
}
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Git'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.AutoSize = $true
$form.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink
$form.Padding = New-Object System.Windows.Forms.Padding 12
$panel = New-Object System.Windows.Forms.TableLayoutPanel
$panel.AutoSize = $true
$panel.ColumnCount = 1
$label = New-Object System.Windows.Forms.Label
$label.Text = $prompt
$label.AutoSize = $true
$label.MaximumSize = New-Object System.Drawing.Size 380, 0
$box = New-Object System.Windows.Forms.TextBox
$box.Width = 380
$box.UseSystemPasswordChar = $prompt -match 'assword|assphrase|PIN'
$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.AutoSize = $true
$buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft
$buttons.Anchor = [System.Windows.Forms.AnchorStyles]::Right
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = ${text(words.askCancel)}
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$ok = New-Object System.Windows.Forms.Button
$ok.Text = ${text(words.askOk)}
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$buttons.Controls.Add($cancel)
$buttons.Controls.Add($ok)
$panel.Controls.Add($label)
$panel.Controls.Add($box)
$panel.Controls.Add($buttons)
$form.Controls.Add($panel)
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Add_Shown({ $form.Activate(); $box.Select() })
if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::Out.Write($box.Text)
`;
  return `#!/bin/sh
# GIT_ASKPASS and SSH_ASKPASS for Glist Studio: a Windows dialog asks, and the
# answer goes to git without passing through the studio.
GLIST_STUDIO_PROMPT="$1" MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 exec powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(form, 'utf16le').toString('base64')}
`;
};

export const createGitService = (context: GitContext) => {
  const say = (key: MessageKey): string => languages[context.language()].git[key];
  const fail = (key: MessageKey): never => { throw new Error(say(key)); };

  // Settings > Git: whether pushed commits are protected, and which branches are.
  let protection = defaultProtection;
  const hostProtected = createHostProtection(context.githubApi ?? 'https://api.github.com', () => context.send('git:changed', null));

  const report = (entry: GlistGitConsoleEntry): void => context.send('git:console', entry);

  // The helper git and ssh run for a password, a key's passphrase or a yes/no
  // question, with the question as its argument. It shows the system's own
  // dialog, so what is typed goes from the system to git without passing
  // through the studio.
  let askpass: string | null | undefined;
  const askpassScript = (): string | null => {
    if (process.platform === 'win32') return windowsAskpassScript(languages[context.language()].git);
    if (process.platform === 'darwin') {
      return `#!/bin/sh
# GIT_ASKPASS and SSH_ASKPASS for Glist Studio: a macOS dialog asks, and the
# answer goes to git without passing through the studio.
case "$1" in *assword*|*assphrase*|*PIN*) hidden="with hidden answer" ;; *) hidden="" ;; esac
if [ "$SSH_ASKPASS_PROMPT" = confirm ]; then
  exec /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title "Git" buttons {"${say('askCancel')}", "${say('askOk')}"} default button "${say('askOk')}"' -e 'end run' "$1" >/dev/null
fi
exec /usr/bin/osascript -e 'on run argv' -e "text returned of (display dialog (item 1 of argv) default answer \\"\\" $hidden with title \\"Git\\" with icon caution)" -e 'end run' "$1"
`;
    }
    const searchPath = (process.env.PATH ?? '').split(path.delimiter);
    const found = askpassPrograms.some((program) => (path.isAbsolute(program)
      ? existsSync(program) : searchPath.some((directory) => existsSync(path.join(directory, program)))));
    if (!found) return null;
    return `#!/bin/sh
# GIT_ASKPASS and SSH_ASKPASS for Glist Studio: the desktop's dialog asks, and
# the answer goes to git without passing through the studio.
prompt="\${1:-${say('askpass')}}"
case "$prompt" in *assword*|*assphrase*|*PIN*) secret=1 ;; *) secret= ;; esac
if [ "$SSH_ASKPASS_PROMPT" = confirm ]; then
  command -v zenity >/dev/null 2>&1 && exec zenity --question --title=Git --text="$prompt"
  command -v kdialog >/dev/null 2>&1 && exec kdialog --title Git --yesno "$prompt"
fi
if command -v zenity >/dev/null 2>&1; then
  [ -n "$secret" ] && exec zenity --password --title="$prompt"
  exec zenity --entry --title=Git --text="$prompt"
fi
if command -v kdialog >/dev/null 2>&1; then
  [ -n "$secret" ] && exec kdialog --title Git --password "$prompt"
  exec kdialog --title Git --inputbox "$prompt"
fi
for helper in ${askpassPrograms.slice(2).join(' ')}; do
  command -v "$helper" >/dev/null 2>&1 && exec "$helper" "$prompt"
done
exit 1
`;
  };
  const askpassPath = async (): Promise<string | null> => {
    if (askpass !== undefined) return askpass;
    const script = askpassScript();
    if (!script) { askpass = null; return null; }
    const file = path.join(context.home(), 'git', 'askpass.sh');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, script, { encoding: 'utf8', mode: 0o700 });
    await fs.chmod(file, 0o700);
    askpass = file;
    return file;
  };

  const environment = async (options: RunOptions): Promise<NodeJS.ProcessEnv> => {
    const env: NodeJS.ProcessEnv = {
      ...context.environment(options.cwd),
      // Nothing waits on a terminal nobody sees: no login prompt, editor or pager.
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_PAGER: 'cat',
      // Refreshing the index while reading could get in the way of git run elsewhere.
      GIT_OPTIONAL_LOCKS: '0',
      ...options.env,
    };
    // In the editor's language, unless the command says otherwise, as branches() does.
    if (!options.env?.LC_ALL) Object.assign(env, toolLanguage(context.language(), env));
    const helper = options.remote ? await askpassPath() : null;
    if (helper) Object.assign(env, { GIT_ASKPASS: helper, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: env.DISPLAY || ':0' });
    return env;
  };

  // The command as the console shows it, without options that are only there for safety.
  const shown = (args: string[]): string => ['git', ...args.filter((arg) => arg !== '--literal-pathspecs')]
    .map((arg) => (/^[\w@%+=:,./{}^~-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`)).join(' ');

  const run = async (args: string[], options: RunOptions): Promise<RunResult> => {
    const env = await environment(options);
    if (options.logged) report({ kind: 'command', text: shown(args) });
    // A remote's login is watched through the credential helpers (see credentialListener).
    const log = options.remote ? path.join(tmpdir(), `glist-studio-credentials-${randomUUID()}`) : null;
    if (log) env.GLIST_STUDIO_CREDENTIALS = log;
    const spawned = log ? ['-c', `credential.helper=${credentialListener}`, ...args] : args;
    const result = await new Promise<RunResult>((resolve) => {
      const child = spawn('git', spawned, { cwd: options.cwd, env, windowsHide: true });
      const stdout: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        if (options.logged) report({ kind: 'output', text: chunk.toString('utf8') });
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (options.logged) report({ kind: 'output', text: chunk.toString('utf8') });
      });
      child.once('error', (error) => resolve({ code: 127, stdout: Buffer.alloc(0), stderr: error.message, args }));
      child.once('close', (code) => {
        if (options.logged && code !== 0) report({ kind: 'error', text: '', code: code ?? 1 });
        resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr, args });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input ?? '');
    });
    if (log) {
      const asked = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => line.split(' '));
      await fs.rm(log, { force: true });
      result.credentials = {
        asked: asked.some(([action]) => action === 'get'),
        accepted: asked.some(([action]) => action === 'store'),
        rejected: asked.some(([action]) => action === 'erase'),
        host: asked.find(([, host]) => host)?.[1] ?? '',
      };
    }
    return result;
  };

  let version: string | null = null;
  const gitVersion = async (): Promise<string | null> => {
    if (version) return version;
    const result = await run(['--version'], { cwd: homedir() });
    version = result.code === 0 ? text(result).trim().replace(/^git version\s*/, '') : null;
    return version;
  };

  const projectRoot = (): string => context.projectRoot() ?? fail('noProject');

  const openRepository = async (root: string = projectRoot()): Promise<Repository | null> => {
    const result = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], { cwd: root });
    if (result.code !== 0) {
      // With no .git in the folder or above it, there is no repository; with one, git says what is wrong.
      for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
        if (existsSync(path.join(folder, '.git'))) throw new Error(result.stderr.trim() || say('notRepository'));
        if (path.dirname(folder) === folder) return null;
      }
    }
    const [top, gitDir, commonDir] = text(result).trim().split('\n');
    return {
      folder: root,
      realFolder: await fs.realpath(root),
      top: path.resolve(top),
      gitDir: path.resolve(gitDir),
      commonDir: path.resolve(root, commonDir),
    };
  };

  const isInside = (folder: string, target: string): boolean => {
    const relative = path.relative(path.resolve(folder), path.resolve(target));
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };

  // The engine's and plugins' folders the open project is built with. They are
  // the only repositories besides the project's that the studio can be asked about.
  const dependencyFolders = async (): Promise<Array<{ name: string; kind: 'engine' | 'plugin'; path: string }>> => {
    if (!context.projectRoot()) return [];
    try { return (await context.dependencies()).filter((entry) => entry.exists); } catch { return []; }
  };

  // The project's repository, or with a root, the engine's or a plugin's.
  const repository = async (root?: unknown): Promise<Repository> => {
    if (root === undefined || root === null) return (await openRepository()) ?? fail('notRepository');
    if (typeof root !== 'string') return fail('outsideRepository');
    const match = (await dependencyFolders()).find((entry) => path.resolve(entry.path) === path.resolve(root));
    if (!match) return fail('outsideRepository');
    return (await openRepository(match.path)) ?? fail('notRepository');
  };

  // The repository a file is in: an engine's or plugin's, or else the project's.
  const repositoryOf = async (filePath: unknown): Promise<Repository> => {
    if (typeof filePath !== 'string' || !filePath) return fail('outsideRepository');
    const match = (await dependencyFolders()).find((entry) => isInside(entry.path, filePath));
    return repository(match?.path);
  };

  // A path git prints, relative to the top folder, as the project spells it.
  const fromGit = (repo: Repository, relative: string): string =>
    path.join(repo.folder, path.relative(repo.realFolder, path.join(repo.top, relative)));

  // A path from the studio, as git takes it: relative to the top folder, with /.
  const toGit = (repo: Repository, filePath: unknown): string => {
    if (typeof filePath !== 'string' || !filePath) return fail('outsideRepository');
    const real = path.join(repo.realFolder, path.relative(repo.folder, path.resolve(filePath)));
    const relative = path.relative(repo.top, real);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('outsideRepository');
    return relative.split(path.sep).join('/');
  };

  const name = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || unsafeName.test(value.trim())) fail('invalidName');
    return (value as string).trim();
  };
  // A branch or tag, including a remote one such as origin/main, or a revision.
  const ref = (value: unknown): string => {
    if (typeof value === 'string' && revisionPattern.test(value)) return value;
    try { return name(value); } catch { return fail('invalidRevision'); }
  };
  const revision = (value: unknown): string => (typeof value === 'string' && revisionPattern.test(value) ? value : fail('invalidRevision'));
  const url = (value: unknown): string => {
    // eslint-disable-next-line no-control-regex
    if (typeof value !== 'string' || !value.trim() || value.trim().startsWith('-') || /[\s\x00-\x1f]/.test(value.trim())) fail('invalidUrl');
    return (value as string).trim();
  };

  // A path as people write it, with the home folder as ~ outside Windows.
  const shortPath = (target: string): string => {
    const relative = path.relative(homedir(), target);
    return process.platform === 'win32' || relative.startsWith('..') || path.isAbsolute(relative) ? target : path.join('~', relative);
  };

  const readFileIfThere = (file: string): Promise<string> => fs.readFile(file, 'utf8').catch(() => '');

  const operation = async (repo: Repository): Promise<{ operation: GlistGitOperation | null; subject?: string }> => {
    const inGitDir = (file: string): string => path.join(repo.gitDir, file);
    // git am keeps its state where an older rebase did; the file applying tells them apart.
    if (existsSync(inGitDir('rebase-apply/applying'))) {
      const message = await readFileIfThere(inGitDir('rebase-apply/final-commit'))
        || (await readFileIfThere(inGitDir('rebase-apply/info'))).match(/^Subject: (.*)$/m)?.[1] || '';
      return { operation: 'am', subject: message.split('\n')[0].trim() || undefined };
    }
    if (existsSync(inGitDir('rebase-merge')) || existsSync(inGitDir('rebase-apply'))) {
      const head = (await readFileIfThere(inGitDir('rebase-merge/head-name')) || await readFileIfThere(inGitDir('rebase-apply/head-name'))).trim();
      return { operation: 'rebase', subject: head.replace(/^refs\/heads\//, '') || undefined };
    }
    if (existsSync(inGitDir('MERGE_HEAD'))) {
      return { operation: 'merge', subject: (await readFileIfThere(inGitDir('MERGE_MSG'))).split('\n')[0] || undefined };
    }
    for (const [file, kind] of [['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
      if (!existsSync(inGitDir(file))) continue;
      const commit = (await readFileIfThere(inGitDir(file))).trim();
      const subject = revisionPattern.test(commit) ? text(await run(['show', '-s', '--format=%h %s', commit], { cwd: repo.folder })).trim() : '';
      return { operation: kind, subject: subject || undefined };
    }
    return { operation: null };
  };

  const readStatus = async (repo: Repository) => {
    // fsmonitor would run a program named in the repository's own settings.
    const result = await run(['-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '-z',
      '--untracked-files=all', '--ignored=matching', '--', '.'], { cwd: repo.folder });
    if (result.code !== 0) throw new Error(result.stderr.trim());
    const status = parseStatus(text(result));
    // A database's journal while changes wait in its tab, and its write-ahead
    // files: SQLite's, never the project's, so not offered for a commit.
    return { ...status, changes: status.changes.filter((change) => change.state !== 'untracked' || !isDatabaseSideFile(change.path)) };
  };

  const describe = async (repo: Repository, kind: GlistGitRepository['kind'], name: string): Promise<GlistGitRepository> => {
    const parsed = await readStatus(repo);
    const stashLog = await readFileIfThere(path.join(repo.commonDir, 'logs', 'refs', 'stash'));
    const { operation: current, subject } = await operation(repo);
    const change = (entry: GitFileChange): GlistGitChange => ({
      path: fromGit(repo, entry.path),
      ...(entry.from ? { from: fromGit(repo, entry.from) } : {}),
      state: entry.state,
      ...(entry.conflict ? { conflict: entry.conflict } : {}),
    });
    return {
      kind,
      name,
      root: repo.top,
      folder: repo.folder,
      location: shortPath(repo.top),
      aboveProject: path.relative(repo.top, repo.realFolder) !== '',
      branch: parsed.branch,
      head: parsed.head,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      operation: current,
      operationSubject: subject,
      changes: parsed.changes.map(change),
      ignored: parsed.ignored.map((entry) => fromGit(repo, entry.replace(/\/$/, '')) + (entry.endsWith('/') ? path.sep : '')),
      stashes: stashLog.split('\n').filter(Boolean).length,
      ...(kind === 'project' && protection.on && parsed.head ? { headPushed: await headPushed(repo) } : {}),
    };
  };

  const status = async (): Promise<GlistGitStatus> => {
    const found = await gitVersion();
    if (!found || !context.projectRoot()) return { version: found, repository: null, dependencies: [] };
    let repository: GlistGitRepository | null = null;
    let top: string | null = null;
    let error: string | undefined;
    try {
      const repo = await openRepository();
      top = repo?.top ?? null;
      if (repo) repository = await describe(repo, 'project', path.basename(repo.folder));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    // The engine and plugins, each once, and not when they are part of the project's own repository.
    const dependencies: GlistGitRepository[] = [];
    for (const entry of await dependencyFolders()) {
      try {
        const repo = await openRepository(entry.path);
        if (!repo || repo.top === top || dependencies.some((known) => known.root === repo.top)) continue;
        dependencies.push(await describe(repo, entry.kind, entry.name));
      } catch { /* A folder git cannot read is left out. */ }
    }
    return { version: found, repository, dependencies, ...(error ? { error } : {}) };
  };

  const log = async (query: GlistGitLogQuery): Promise<GlistGitCommit[]> => {
    const repo = await repository(query?.root);
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(query?.limit) || 300)));
    const skip = Math.max(0, Math.floor(Number(query?.skip) || 0));
    const args = ['-c', 'log.showSignature=false', 'log', '--date-order', `--format=${logFormat}`, `--max-count=${limit}`, `--skip=${skip}`];
    const words = typeof query?.text === 'string' ? query.text.trim() : '';
    if (words) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${words}`);
    if (query?.ref) args.push(ref(query.ref));
    else args.push('--exclude=refs/stash', '--all');
    if (query?.path) args.push('--follow', '--', toGit(repo, query.path));
    const result = await run(query?.path ? literal(args) : args, { cwd: repo.folder });
    // A repository without commits has no history yet.
    if (result.code !== 0) return [];
    const commits = parseLog(text(result));
    // The search also finds a commit by the start of its hash.
    if (words && skip === 0 && /^[0-9a-f]{4,40}$/i.test(words) && !commits.some((commit) => commit.hash.startsWith(words.toLowerCase()))) {
      const found = await run(['-c', 'log.showSignature=false', 'log', '-1', `--format=${logFormat}`, `${words}^{commit}`], { cwd: repo.folder });
      if (found.code === 0) commits.unshift(...parseLog(text(found)));
    }
    return commits;
  };

  // A patch to share. Commits as git format-patch writes them, which git am
  // makes again with their authors and messages, oldest first; merge commits
  // have none of their own. Changes not committed yet as a diff against the
  // last commit, new files too.
  const patch = async (request: unknown): Promise<GlistGitPatch> => {
    const asked = (request ?? {}) as { root?: unknown; commits?: unknown; paths?: unknown };
    const repo = await repository(asked.root);
    const repositoryName = path.basename(repo.folder);
    if (Array.isArray(asked.commits) && asked.commits.length > 0) {
      const hashes = new Set<string>();
      for (const value of asked.commits) {
        const resolved = text(await run(['rev-parse', '--verify', '--quiet', `${revision(value)}^{commit}`], { cwd: repo.folder })).trim();
        if (!resolved) fail('invalidRevision');
        hashes.add(resolved);
      }
      // In the order history has them, parents first: dates can tie, ancestry cannot.
      const ordered = text(await run(['rev-list', '--topo-order', '--reverse', ...hashes], { cwd: repo.folder }))
        .split('\n').filter((hash) => hashes.has(hash));
      const parts: string[] = [];
      for (const hash of ordered) {
        const made = await run(['format-patch', '-1', '--stdout', '--binary', hash], { cwd: repo.folder });
        if (made.code !== 0) fail('invalidRevision');
        parts.push(text(made));
      }
      const name = ordered.length === 1
        ? text(await run(['show', '-s', '--format=%f', ordered[0]], { cwd: repo.folder })).trim() || ordered[0].slice(0, 7)
        : `${repositoryName}-${ordered.length}-commits`;
      return { patch: parts.join(''), name: `${name}.patch`, commits: parts.filter(Boolean).length };
    }
    const chosen = new Set((Array.isArray(asked.paths) ? asked.paths : []).map((entry) => toGit(repo, entry)));
    const changes = (await readStatus(repo)).changes.filter((change) => chosen.has(change.path) || (change.from !== undefined && chosen.has(change.from)));
    const tracked = changes.filter((change) => change.state !== 'untracked').flatMap((change) => (change.from ? [change.from, change.path] : [change.path]));
    const parts: string[] = [];
    if (tracked.length > 0) {
      const hasHead = (await run(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repo.folder })).code === 0;
      // Before the first commit, against nothing.
      const base = hasHead ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
      parts.push(text(await run(literal(['diff', '--binary', base, '--', ...tracked]), { cwd: repo.folder })));
    }
    for (const change of changes.filter((entry) => entry.state === 'untracked')) {
      // git diff says 1 when there is a difference, which a new file always is.
      parts.push(text(await run(['diff', '--no-index', '--binary', '--', '/dev/null', change.path], { cwd: repo.folder })));
    }
    return { patch: parts.join(''), name: `${repositoryName}-changes.patch`, commits: 0 };
  };

  // A patch brought in. Commits are made again with git am, their authors and
  // messages kept; changes go into the files with git apply. Either way a
  // clash leaves both sides marked, for the Commit view to resolve.
  const applyPatch = async (repo: Repository, value: unknown): Promise<GlistGitResult> => {
    const patchText = typeof value === 'string' ? value : '';
    if (!/^(diff --git |--- |From [0-9a-f]{40} )/m.test(patchText)) fail('notPatch');
    if (/^From [0-9a-f]{40} /.test(patchText)) {
      const applied = await run(['am', '--3way'], { cwd: repo.folder, input: patchText, logged: true });
      return applied.code === 0 ? done(say('patchCommitted')) : explain(applied, repo);
    }
    const merged = await run(['apply', '--3way'], { cwd: repo.folder, input: patchText, logged: true });
    if (merged.code === 0) return done(say('patchApplied'));
    // Files changed since the last commit cannot take a three-way apply, which then
    // changes nothing; straight into them then. git apply takes all of a patch or none.
    if (!(await readStatus(repo)).changes.some((entry) => entry.state === 'conflict')) {
      const direct = await run(['apply'], { cwd: repo.folder, input: patchText, logged: true });
      return direct.code === 0 ? done(say('patchApplied')) : explain(direct, repo);
    }
    return explain(merged, repo);
  };

  // A stash made with its new files keeps them in a third parent of its own,
  // which a diff against the first parent does not show.
  const stashedNewFiles = async (repo: Repository, value: unknown, parents: string[]): Promise<GlistGitCommitFile[]> => {
    if (!/^stash@\{\d+\}$/.test(String(value)) || parents.length < 3) return [];
    const listed = await run(['ls-tree', '-r', '-z', '--name-only', parents[2]], { cwd: repo.folder });
    return text(listed).split('\0').filter(Boolean).map((file) => ({ path: fromGit(repo, file), state: 'untracked' as const, at: parents[2] }));
  };

  const commitDetails = async (value: unknown, root?: unknown): Promise<GlistGitCommitDetails> => {
    const repo = await repository(root);
    const rev = revision(value);
    const format = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%s%x1f%B';
    const shownCommit = await run(['-c', 'log.showSignature=false', 'show', '-s', `--format=${format}`, rev], { cwd: repo.folder });
    if (shownCommit.code !== 0) fail('invalidRevision');
    const [hash, short, parents, author, email, date, committer, committerDate, refs, subject, message] = text(shownCommit).split('\x1f');
    const parentList = parents ? parents.split(' ') : [];
    const base = parentList[0] ?? null;
    const files = await run(base
      ? ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', '-z', base, hash]
      : ['diff-tree', '-r', '-M', '--root', '--no-commit-id', '--name-status', '-z', hash], { cwd: repo.folder });
    return {
      hash,
      short,
      parents: parentList,
      author,
      email,
      date: Number(date),
      committer,
      committerDate: Number(committerDate),
      refs: refs ? refs.split(', ').map((entry) => entry.replace(/^HEAD -> /, '')).filter((entry) => entry !== 'HEAD' && !entry.endsWith('/HEAD')) : [],
      subject,
      message: message.trim(),
      base,
      files: [
        ...parseNameStatus(text(files)).map((file) => ({
          path: fromGit(repo, file.path),
          ...(file.from ? { from: fromGit(repo, file.from) } : {}),
          state: file.state,
        })),
        ...await stashedNewFiles(repo, value, parentList),
      ],
    };
  };

  // Commits of the current branch no remote has yet: the ones that can be
  // dropped without rewriting history someone else may already have.
  const unpublishedIn = async (repo: Repository): Promise<string[]> =>
    text(await run(['rev-list', '--max-count=500', 'HEAD', '--not', '--remotes'], { cwd: repo.folder })).split('\n').filter(Boolean);
  const unpublished = async (root?: unknown): Promise<string[]> => unpublishedIn(await repository(root));

  // Takes a commit out of the current branch, the ones after it replayed
  // without it; changes not committed yet are put aside meanwhile. Only one not
  // pushed yet, and not a merge or before one, which a rebase would flatten.
  const dropCommit = async (repo: Repository, value: unknown): Promise<GlistGitResult> => {
    const hash = text(await run(['rev-parse', '--verify', '--quiet', `${revision(value)}^{commit}`], { cwd: repo.folder })).trim();
    if (!hash) fail('invalidRevision');
    if ((await run(['merge-base', '--is-ancestor', hash, 'HEAD'], { cwd: repo.folder })).code !== 0) fail('dropOtherBranch');
    if (!(await unpublishedIn(repo)).includes(hash)) fail('dropPushed');
    const merges = text(await run(['rev-list', '--merges', `${hash}..HEAD`], { cwd: repo.folder })).trim();
    if (await commitParents(repo, hash) !== 1 || merges) fail('dropMerge');
    return steps(repo, [['rebase', '--autostash', '--onto', `${hash}^`, hash]]);
  };

  const branches = async (root?: unknown): Promise<GlistGitBranch[]> => {
    const repo = await repository(root);
    const result = await run(['for-each-ref', `--format=${branchFormat}`, 'refs/heads', 'refs/remotes'],
      { cwd: repo.folder, env: { LC_ALL: 'C' } });
    return result.code === 0 ? parseBranches(text(result)) : [];
  };

  const tags = async (root?: unknown): Promise<GlistGitTag[]> => {
    const repo = await repository(root);
    const result = await run(['for-each-ref', `--format=${tagFormat}`, 'refs/tags'], { cwd: repo.folder });
    return result.code === 0 ? parseTags(text(result)) : [];
  };

  const remotes = async (root?: unknown): Promise<GlistGitRemote[]> => {
    const repo = await repository(root);
    return parseRemotes(text(await run(['remote', '-v'], { cwd: repo.folder })));
  };

  const stashes = async (root?: unknown): Promise<GlistGitStash[]> => {
    const repo = await repository(root);
    const result = await run(['stash', 'list', `--format=${stashFormat}`], { cwd: repo.folder });
    return result.code === 0 ? parseStashes(text(result)) : [];
  };

  const fileAt = async (value: unknown, filePath: unknown): Promise<GlistGitFileVersion> => {
    const repo = await repositoryOf(filePath);
    const result = await run(['cat-file', 'blob', `${revision(value)}:${toGit(repo, filePath)}`], { cwd: repo.folder });
    if (result.code !== 0) return { text: null };
    if (result.stdout.length > 5 * 1024 * 1024) return { text: '', tooLarge: true };
    if (result.stdout.subarray(0, 8000).includes(0)) return { text: '', binary: true };
    return { text: text(result) };
  };

  // A file's bytes as a commit has it, however large, for what is compared
  // other than as text (database-diff.ts); null if the commit has no such file.
  const blobAt = async (value: unknown, filePath: unknown): Promise<Buffer | null> => {
    const repo = await repositoryOf(filePath);
    const result = await run(['cat-file', 'blob', `${revision(value)}:${toGit(repo, filePath)}`], { cwd: repo.folder });
    return result.code === 0 ? result.stdout : null;
  };

  // Against what is in the editor, so lines typed since the last save count as not committed.
  const blame = async (filePath: unknown, contents: unknown): Promise<GlistGitBlameLine[]> => {
    const repo = await repositoryOf(filePath);
    const result = await run(literal(['blame', '--line-porcelain', '--contents', '-', '--', toGit(repo, filePath)]),
      { cwd: repo.folder, input: typeof contents === 'string' ? contents : '' });
    return result.code === 0 ? parseBlame(text(result)) : [];
  };

  // Git's own settings, from the system, the user and the project. Without a
  // name there, the name git would take from the computer account is offered.
  const identity = async (): Promise<GlistGitIdentity> => {
    const cwd = context.projectRoot() ?? homedir();
    const [userName, email] = await Promise.all(['user.name', 'user.email'].map((key) => run(['config', key], { cwd })));
    const found = { name: text(userName).trim(), email: text(email).trim() };
    if (found.name) return found;
    const guessed = await run(['var', 'GIT_AUTHOR_IDENT'], { cwd });
    const suggestedName = guessed.code === 0 ? text(guessed).split('<')[0].trim() : '';
    return suggestedName ? { ...found, suggestedName } : found;
  };

  const lastMessage = async (root?: unknown): Promise<string> => {
    const repo = await repository(root);
    const result = await run(['log', '-1', '--format=%B'], { cwd: repo.folder });
    return result.code === 0 ? text(result).trim() : '';
  };

  const upstreamRemote = async (repo: Repository, branch: string | null): Promise<string | null> => {
    if (!branch) return null;
    const result = await run(['config', `branch.${branch}.remote`], { cwd: repo.folder });
    return result.code === 0 ? text(result).trim() : null;
  };

  // The remote branch a push of the current branch goes to: its upstream's, or its own name.
  const pushTarget = (branch: string | null, upstream: string | null, remote: string | null): string | null =>
    (upstream && remote && upstream.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : branch);

  const isProtected = async (folder: string, remote: string | null, branch: string | null, wait = false): Promise<boolean> => {
    if (!protection.on || !branch) return false;
    if (matchesBranch(branch, protection.branches)) return true;
    const address = remote ? text(await run(['remote', 'get-url', '--push', remote], { cwd: folder })).trim() : '';
    return (await hostProtected(address || null, wait)).includes(branch);
  };

  // Whether HEAD's commit is on a remote branch already, so others may have it.
  const headPushed = async (repo: Repository): Promise<boolean> =>
    text(await run(['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes/'], { cwd: repo.folder })).trim() !== '';

  // What Push would send, and where.
  const outgoing = async (root?: unknown) => {
    const repo = await repository(root);
    const parsed = await readStatus(repo);
    const remoteNames = text(await run(['remote'], { cwd: repo.folder })).split('\n').filter(Boolean);
    const remote = await upstreamRemote(repo, parsed.branch)
      ?? (remoteNames.includes('origin') ? 'origin' : remoteNames[0] ?? null);
    let commits: GlistGitCommit[] = [];
    if (parsed.head) {
      const range = parsed.upstream ? ['@{upstream}..HEAD'] : ['HEAD', '--not', ...(remote ? [`--remotes=${remote}`] : [])];
      const result = await run(['-c', 'log.showSignature=false', 'log', `--format=${logFormat}`, '--max-count=200', ...range], { cwd: repo.folder });
      if (result.code === 0) commits = parseLog(text(result));
    }
    const target = parsed.upstream ? pushTarget(parsed.branch, parsed.upstream, remote) : parsed.branch;
    return { remote, branch: parsed.branch, remotes: remoteNames, commits, protected: await isProtected(repo.folder, remote, target, true) };
  };

  // The subcommand run, past options such as -c name=value.
  const subcommand = (args: string[]): string => {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '-c' || args[index] === '-C') index += 1;
      else if (!args[index].startsWith('-')) return args[index];
    }
    return '';
  };
  // Commands that make commits, which need a name and an email.
  const committing = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'pull', 'stash']);
  const github = (host: string): boolean => /(^|\.)github\.com$/i.test(host);

  // Why a command did not work, in the words people need, told from what git
  // keeps the same in every language and version: what it asked the credential
  // helpers, push's porcelain lines, and the repository's state afterwards.
  // git's own sentences are never read; when none of these tells, they are
  // shown as git wrote them, in the language it wrote them in.
  const explain = async (result: RunResult, repo?: Repository | null): Promise<GlistGitResult> => {
    const command = subcommand(result.args);
    const fails = (key: MessageKey, flags: Partial<GlistGitResult> = {}): GlistGitResult => ({ success: false, message: say(key), ...flags });
    const { credentials } = result;
    if (credentials?.rejected) return fails(github(credentials.host) ? 'githubToken' : 'auth');
    if (credentials?.asked && !credentials.accepted) return fails('loginNeeded');
    if (command === 'push' && /^!\t[^\t]*\t\[rejected\]/m.test(text(result))) return fails('rejected', { rejected: true });
    if (repo) {
      const cwd = repo.folder;
      const parsed: GitStatus | null = await readStatus(repo).catch((): null => null);
      const stopped = (await operation(repo).catch((): { operation: null } => ({ operation: null }))).operation;
      if (parsed?.changes.some((entry) => entry.state === 'conflict') || (stopped && committing.has(command))) {
        return fails('conflicts', { conflicts: true });
      }
      // Kept in a branch only when it is in neither HEAD nor what the branch follows.
      if (command === 'branch' && result.args.includes('-d')) {
        const branch = result.args[result.args.length - 1];
        const inHead = (await run(['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd })).code;
        const upstream = (await run(['rev-parse', '--verify', '--quiet', `${branch}@{upstream}`], { cwd })).code === 0
          ? (await run(['merge-base', '--is-ancestor', branch, `${branch}@{upstream}`], { cwd })).code : 1;
        if (inHead === 1 && upstream === 1) return fails('notMerged', { notMerged: true });
      }
      // git var fails exactly when git cannot make up a name and an email.
      if (committing.has(command)) {
        const known = await Promise.all(['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map((name) => run(['var', name], { cwd })));
        if (known.some((answer) => answer.code !== 0)) return fails('identity');
      }
      if (command === 'pull' && (await run(['rev-parse', '--verify', '--quiet', '@{upstream}'], { cwd })).code !== 0) return fails('noUpstream');
      // A branch checkout that changed files stop: offered with them stashed. Not
      // for files checked out from a commit (after --), a lock left by another git,
      // or a name that is no commit.
      if (command === 'checkout' && !result.args.includes('--') && parsed && parsed.changes.length > 0
        && !existsSync(path.join(repo.gitDir, 'index.lock'))
        && (await run(['rev-parse', '--verify', '--quiet', `${result.args[result.args.length - 1]}^{commit}`], { cwd })).code === 0) {
        return fails('localChanges', { localChanges: true });
      }
    }
    // What the remote itself says is in no language of git's; the rest is git's own, last lines first to go.
    const own = result.stderr.split('\n').map((line) => line.trimEnd()).filter((line) => line && !line.startsWith('remote:')).slice(-8).join('\n');
    return { success: false, message: own || `${say('exitCode')} ${result.code}` };
  };

  const done = (message: string = say('done')): GlistGitResult => ({ success: true, message });
  // What was refused before git ran, such as a name git could take for an option.
  const failure = (error: unknown): GlistGitResult => ({ success: false, message: error instanceof Error ? error.message : String(error) });

  // Runs commands in order, stopping at the first that fails.
  const steps = async (repo: Repository, commands: string[][], options: Partial<RunOptions> = {}): Promise<GlistGitResult> => {
    for (const args of commands) {
      const result = await run(args, { cwd: repo.folder, logged: true, ...options });
      if (result.code !== 0) return explain(result, repo);
    }
    return done();
  };

  // File paths as file names, not patterns, even with * or ? in them. Not set
  // for every command: git stash -u then leaves the untracked files it saved.
  const literal = (args: string[]): string[] => ['--literal-pathspecs', ...args];

  // Paths git takes on the command line; very many go through standard input instead.
  const withPaths = (args: string[], paths: string[]): { args: string[]; input?: string } => (paths.join('').length > 24000
    ? { args: literal([...args, '--pathspec-from-file=-', '--pathspec-file-nul']), input: paths.join('\0') }
    : { args: literal([...args, '--', ...paths]) });

  const commit = async (repo: Repository, action: Extract<GlistGitAction, { kind: 'commit' }>): Promise<GlistGitResult> => {
    const message = typeof action.message === 'string' ? action.message.trim() : '';
    if (!message) fail('messageRequired');
    const parsed = await readStatus(repo);
    const chosen = new Set((Array.isArray(action.paths) ? action.paths : []).map((entry) => toGit(repo, entry)));
    const { operation: current } = await operation(repo);
    if (current === 'rebase') fail('rebaseCommit');
    if (current === 'am') fail('patchCommit');
    if (current) {
      // Concluding a merge commits everything it brought, with the files chosen added.
      if (parsed.changes.some((entry) => entry.state === 'conflict')) fail('unresolved');
      if (chosen.size > 0) {
        const add = withPaths(['add', '-A'], [...chosen]);
        const added = await run(add.args, { cwd: repo.folder, input: add.input, logged: true });
        if (added.code !== 0) return explain(added, repo);
      }
      const result = await run(['commit', '-m', message], { cwd: repo.folder, logged: true });
      return result.code === 0 ? done(say('committed')) : explain(result, repo);
    }
    if (chosen.size === 0 && !action.amend) fail('nothingSelected');
    if (action.amend && protection.on && parsed.head && await headPushed(repo)) fail('amendPushed');
    // Only the chosen files are committed, as they are on disk, whatever else was
    // staged; new files have to be known to git for that.
    const untracked = parsed.changes.filter((entry) => entry.state === 'untracked' && chosen.has(entry.path)).map((entry) => entry.path);
    if (untracked.length > 0) {
      const add = withPaths(['add'], untracked);
      const added = await run(add.args, { cwd: repo.folder, input: add.input, logged: true });
      if (added.code !== 0) return explain(added, repo);
    }
    const committing = withPaths(['commit', '-m', message, ...(action.amend ? ['--amend'] : []), '--only'], [...chosen]);
    const result = await run(chosen.size > 0 ? committing.args : ['commit', '-m', message, '--amend', '--only'],
      { cwd: repo.folder, input: committing.input, logged: true });
    return result.code === 0 ? done(say('committed')) : explain(result, repo);
  };

  // Tracked files go back to the last commit. Files the last commit does not
  // have leave the index and go to the trash, so they can still be brought back.
  const rollback = async (repo: Repository, paths: unknown[]): Promise<GlistGitResult> => {
    const parsed = await readStatus(repo);
    const chosen = new Set(paths.map((entry) => toGit(repo, entry)));
    const restore: string[] = [];
    const remove: string[] = [];
    parsed.changes.filter((entry) => chosen.has(entry.path)).forEach((entry) => {
      if (entry.state === 'untracked' || entry.state === 'conflict') return;
      if (entry.state === 'added' || entry.state === 'renamed' || !parsed.head) remove.push(entry.path);
      else restore.push(entry.path);
      if (entry.from) restore.push(entry.from);
    });
    if (restore.length > 0 && parsed.head) {
      const checkout = withPaths(['checkout', 'HEAD'], restore);
      const result = await run(checkout.args, { cwd: repo.folder, input: checkout.input, logged: true });
      if (result.code !== 0) return explain(result, repo);
    }
    if (remove.length > 0) {
      const unstage = withPaths(['rm', '--cached', '-q', '-f', '-r'], remove);
      const result = await run(unstage.args, { cwd: repo.folder, input: unstage.input, logged: true });
      if (result.code !== 0) return explain(result, repo);
      for (const entry of remove) {
        const file = path.join(repo.top, entry);
        if (existsSync(file)) await context.trash(file);
      }
    }
    return done();
  };

  const isDirectory = (entry: string): boolean => {
    try { return statSync(entry).isDirectory(); } catch { return false; }
  };

  // Adds lines to the project's .gitignore, relative to the project folder.
  const ignore = async (repo: Repository, paths: unknown[]): Promise<GlistGitResult> => {
    const file = path.join(repo.folder, '.gitignore');
    const current = await readFileIfThere(file);
    const lines = paths.map((entry) => {
      if (typeof entry !== 'string') return fail('outsideRepository');
      const relative = path.relative(repo.folder, path.resolve(entry));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('outsideRepository');
      return `/${relative.split(path.sep).join('/')}${isDirectory(entry) ? '/' : ''}`;
    }).filter((line) => !current.split(/\r?\n/).includes(line));
    if (lines.length > 0) await fs.writeFile(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`, 'utf8');
    report({ kind: 'command', text: `.gitignore += ${lines.join(' ')}` });
    return done();
  };

  const stageOf = async (repo: Repository, relative: string, stage: 2 | 3): Promise<boolean> => {
    const result = await run(literal(['ls-files', '-u', '-z', '--', relative]), { cwd: repo.folder });
    return text(result).split('\0').some((line) => line.split(/\s+/)[2] === String(stage));
  };

  // Mine is what the person did. In a merge, cherry-pick or revert that is the
  // current branch, which git calls ours (stage 2). In a rebase it is the
  // commits being replayed, and in a stash brought back the stashed changes,
  // both of which git calls theirs (stage 3).
  const resolve = async (repo: Repository, filePath: unknown, side: unknown): Promise<GlistGitResult> => {
    const relative = toGit(repo, filePath);
    const { operation: current } = await operation(repo);
    const mineStage = current === 'merge' || current === 'cherry-pick' || current === 'revert' || current === 'am' ? 2 : 3;
    const stage: 2 | 3 = side === 'mine' ? mineStage : (5 - mineStage) as 2 | 3;
    const commands = await stageOf(repo, relative, stage)
      ? [literal(['checkout', stage === 2 ? '--ours' : '--theirs', '--', relative]), literal(['add', '--', relative])]
      : [literal(['rm', '-q', '--', relative])];
    return steps(repo, commands);
  };

  const abortOrContinue = async (repo: Repository, step: 'abort' | 'continue' | 'skip'): Promise<GlistGitResult> => {
    const { operation: current } = await operation(repo);
    if (!current) fail('nothingInProgress');
    if (step === 'continue') {
      if (current === 'merge') fail('messageRequired');
      // The files resolved in the editor count as resolved.
      const added = await steps(repo, [['add', '-u', '--', '.']]);
      if (!added.success) return added;
      // A patch whose changes were all left out, keeping one's own side, has nothing left to commit: it is skipped.
      if (current === 'am' && (await run(['diff', '--cached', '--quiet', 'HEAD'], { cwd: repo.folder })).code === 0) {
        return steps(repo, [['am', '--skip']]);
      }
      const continued = await run([current, '--continue'], { cwd: repo.folder, logged: true });
      return continued.code === 0 ? done() : explain(continued, repo);
    }
    if (step === 'skip' && current !== 'merge') return steps(repo, [[current, '--skip']]);
    return steps(repo, [[current, '--abort']]);
  };

  const checkout = async (repo: Repository, action: Extract<GlistGitAction, { kind: 'checkout' }>): Promise<GlistGitResult> => {
    const target = ref(action.ref);
    const local = await run(['show-ref', '--verify', '--quiet', `refs/heads/${target}`], { cwd: repo.folder });
    const remote = local.code !== 0
      ? await run(['show-ref', '--verify', '--quiet', `refs/remotes/${target}`], { cwd: repo.folder }) : null;
    let command = ['checkout', target];
    if (remote?.code === 0) {
      // A remote branch is checked out as a local one that follows it.
      const localName = target.slice(target.indexOf('/') + 1);
      const exists = await run(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], { cwd: repo.folder });
      command = exists.code === 0 ? ['checkout', localName] : ['checkout', '--track', target];
    } else if (local.code !== 0) command = ['checkout', '--detach', target];
    if (!action.smart) return steps(repo, [command]);
    const before = parseStashes(text(await run(['stash', 'list', `--format=${stashFormat}`], { cwd: repo.folder }))).length;
    const stashed = await steps(repo, [['stash', 'push', '--include-untracked', '-m', say('stashBeforeCheckout')]]);
    if (!stashed.success) return stashed;
    const after = parseStashes(text(await run(['stash', 'list', `--format=${stashFormat}`], { cwd: repo.folder }))).length;
    const switched = await steps(repo, [command]);
    if (after === before) return switched;
    const restored = await steps(repo, [['stash', 'pop']]);
    return switched.success ? restored : switched;
  };

  const createBranch = async (repo: Repository, action: Extract<GlistGitAction, { kind: 'create-branch' }>): Promise<GlistGitResult> => {
    const branch = name(action.name);
    const valid = await run(['check-ref-format', '--branch', branch], { cwd: repo.folder });
    if (valid.code !== 0) fail('invalidName');
    const start = action.start ? [ref(action.start)] : [];
    return steps(repo, [action.checkout ? ['checkout', '-b', branch, ...start] : ['branch', branch, ...start]]);
  };

  const deleteBranch = async (repo: Repository, action: Extract<GlistGitAction, { kind: 'delete-branch' }>): Promise<GlistGitResult> => {
    const branch = ref(action.name);
    if (!action.remote) return steps(repo, [['branch', action.force ? '-D' : '-d', branch]]);
    const slash = branch.indexOf('/');
    if (slash < 1) fail('invalidName');
    return steps(repo, [['push', '--progress', branch.slice(0, slash), '--delete', branch.slice(slash + 1)]], { remote: true });
  };

  const commitParents = async (repo: Repository, commit: string): Promise<number> =>
    text(await run(['show', '-s', '--format=%P', commit], { cwd: repo.folder })).trim().split(' ').filter(Boolean).length;

  const push = async (repo: Repository, action: Extract<GlistGitAction, { kind: 'push' }>): Promise<GlistGitResult> => {
    const parsed = await readStatus(repo);
    if (!parsed.branch) fail('invalidRevision');
    const remoteNames = text(await run(['remote'], { cwd: repo.folder })).split('\n').filter(Boolean);
    const remote = action.remote ? name(action.remote) : await upstreamRemote(repo, parsed.branch)
      ?? (remoteNames.includes('origin') ? 'origin' : remoteNames[0]);
    if (!remote) fail('noRemote');
    const target = action.remote ? parsed.branch : pushTarget(parsed.branch, parsed.upstream, remote);
    if (action.force && await isProtected(repo.folder, remote, target, true)) {
      return { success: false, message: say('forceProtected').replace('{branch}', target ?? '') };
    }
    // --porcelain: a refused branch is a line that starts with !, the same in every language.
    const args = ['push', '--porcelain', '--progress', ...(action.force ? ['--force-with-lease'] : []), ...(action.tags ? ['--tags'] : [])];
    // A branch without an upstream gets one of the same name, and follows it from then on.
    args.push(...(parsed.upstream && !action.remote ? [] : ['--set-upstream', remote, parsed.branch]));
    const result = await steps(repo, [args], { remote: true });
    return result.success ? done(say('pushed')) : result;
  };

  const act = async (action: GlistGitAction, root?: unknown): Promise<GlistGitResult> => {
    if (action?.kind === 'init') {
      const root = projectRoot();
      if (await openRepository()) fail('alreadyRepository');
      const configured = await run(['config', '--get', 'init.defaultBranch'], { cwd: root });
      const result = await run(['init', ...(configured.code === 0 ? [] : ['--initial-branch=main'])], { cwd: root, logged: true });
      if (result.code !== 0) return explain(result);
      // Built files stay out of the repository from the start.
      const ignoreFile = path.join(root, '.gitignore');
      if (!existsSync(ignoreFile)) await fs.writeFile(ignoreFile, defaultIgnore, 'utf8');
      return done();
    }
    if (action?.kind === 'identity') {
      const userName = typeof action.name === 'string' ? action.name.trim() : '';
      const email = typeof action.email === 'string' ? action.email.trim() : '';
      const cwd = context.projectRoot() ?? homedir();
      const set = async (key: string, value: string): Promise<RunResult> => (value
        ? run(['config', '--global', key, value], { cwd, logged: true })
        : run(['config', '--global', '--unset', key], { cwd, logged: true }));
      const results = [await set('user.name', userName), await set('user.email', email)];
      const failed = results.find((result) => result.code !== 0 && result.code !== 5);
      return failed ? explain(failed) : done();
    }
    const repo = await repository(root);
    switch (action?.kind) {
      case 'commit': return commit(repo, action);
      case 'rollback': return rollback(repo, Array.isArray(action.paths) ? action.paths : []);
      case 'ignore': return ignore(repo, Array.isArray(action.paths) ? action.paths : []);
      case 'resolve': return resolve(repo, action.path, action.side);
      case 'apply-patch': return applyPatch(repo, action.patch);
      case 'unresolve': return steps(repo, [literal(['checkout', '-m', '--', toGit(repo, action.path)])]);
      case 'mark-resolved': {
        const paths = (Array.isArray(action.paths) ? action.paths : []).map((entry) => toGit(repo, entry));
        const add = withPaths(['add', '-A'], paths);
        const result = await run(add.args, { cwd: repo.folder, input: add.input, logged: true });
        return result.code === 0 ? done() : explain(result, repo);
      }
      case 'abort': case 'continue': case 'skip': return abortOrContinue(repo, action.kind);
      case 'checkout': return checkout(repo, action);
      case 'create-branch': return createBranch(repo, action);
      case 'rename-branch': return steps(repo, [['branch', '-m', ref(action.from), name(action.to)]]);
      case 'delete-branch': return deleteBranch(repo, action);
      // Changes not committed yet are put aside while it runs, and back after.
      case 'merge': return steps(repo, [['merge', '--no-edit', '--autostash', ref(action.ref)]]);
      case 'rebase': return steps(repo, [['rebase', '--autostash', ref(action.onto)]]);
      case 'cherry-pick': {
        const commitHash = revision(action.commit);
        const merge = await commitParents(repo, commitHash) > 1;
        return steps(repo, [['cherry-pick', ...(merge ? ['-m', '1'] : []), commitHash]]);
      }
      case 'drop-commit': return dropCommit(repo, action.commit);
      case 'revert': {
        const commitHash = revision(action.commit);
        const merge = await commitParents(repo, commitHash) > 1;
        return steps(repo, [['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), commitHash]]);
      }
      case 'reset': {
        const mode = action.mode === 'soft' || action.mode === 'hard' ? action.mode : 'mixed';
        return steps(repo, [['reset', `--${mode}`, revision(action.commit)]]);
      }
      case 'create-tag': {
        const tag = name(action.name);
        const target = action.commit ? [revision(action.commit)] : [];
        const message = typeof action.message === 'string' ? action.message.trim() : '';
        return steps(repo, [message ? ['tag', '-a', tag, '-m', message, ...target] : ['tag', tag, ...target]]);
      }
      case 'delete-tag': return steps(repo, [['tag', '-d', name(action.name)]]);
      case 'fetch': return steps(repo, [['fetch', '--all', '--prune', '--progress']], { remote: true });
      case 'pull': {
        const parsed = await readStatus(repo);
        if (!parsed.upstream) fail('noUpstream');
        return steps(repo, [['pull', '--progress', '--autostash', action.rebase ? '--rebase' : '--no-rebase']], { remote: true });
      }
      case 'push': return push(repo, action);
      case 'add-remote': return steps(repo, [['remote', 'add', name(action.name), url(action.url)]]);
      case 'remove-remote': return steps(repo, [['remote', 'remove', name(action.name)]]);
      case 'set-remote-url': return steps(repo, [['remote', 'set-url', name(action.name), url(action.url)]]);
      case 'stash': {
        const message = typeof action.message === 'string' ? action.message.trim() : '';
        // Only the files asked for, each named as it is: the literal magic per path,
        // since --literal-pathspecs makes git stash -u leave the new files it saved on disk.
        const paths = (Array.isArray(action.paths) ? action.paths : []).map((entry) => `:(literal)${toGit(repo, entry)}`);
        return steps(repo, [['stash', 'push', ...(action.untracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : []),
          ...(paths.length > 0 ? ['--', ...paths] : [])]]);
      }
      case 'unstash': {
        const stash = revision(action.name);
        return steps(repo, [['stash', action.pop ? 'pop' : 'apply', stash]]);
      }
      case 'drop-stash': return steps(repo, [['stash', 'drop', revision(action.name)]]);
      default: return fail('invalidName');
    }
  };

  // One change to a repository at a time, as git's own locks expect.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch((): undefined => undefined);
    return next;
  };

  const clone = async (address: unknown, folder: unknown): Promise<GlistProcessResult & { root?: string }> => {
    const source = url(address);
    const folderName = name(folder);
    if (/[\\/]/.test(folderName)) fail('invalidName');
    const parent = context.projectsDirectory();
    const target = path.join(parent, folderName);
    if (existsSync(target)) fail('projectExists');
    await fs.mkdir(parent, { recursive: true });
    const result = await run(['clone', '--progress', '--', source, target], { cwd: parent, logged: true, remote: true });
    if (result.code !== 0) return explain(result);
    return { success: true, message: say('done'), root: target };
  };

  // Tells the studio when files or the repository change on disk, so the
  // Commit view and the explorer follow edits and git used elsewhere.
  let watchers: FSWatcher[] = [];
  let watching = false;
  let timer: NodeJS.Timeout | null = null;
  const changed = (file?: string | null): void => {
    if (file && /^(_build|node_modules|\.cache)([\\/]|$)|(^|[\\/])\.git[\\/](objects|logs)[\\/]/.test(file)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; context.send('git:changed', null); }, 300);
  };
  const stopWatching = (): void => {
    watchers.forEach((watcher) => watcher.close());
    watchers = [];
  };
  const rewatch = async (): Promise<void> => {
    stopWatching();
    const root = context.projectRoot();
    if (!watching || !root) return;
    const folders = [root];
    try {
      const repo = await openRepository();
      if (repo && !repo.gitDir.startsWith(repo.realFolder + path.sep)) folders.push(repo.gitDir);
    } catch { /* Not a repository: the project folder is still watched, for git init. */ }
    folders.forEach((folder) => {
      try {
        const watcher = watch(folder, { recursive: true }, (_event, file) => changed(file?.toString()));
        watcher.on('error', () => undefined);
        watchers.push(watcher);
      } catch { /* The focus and save refreshes still work. */ }
    });
  };

  return {
    handlers: {
      gitStatus: status,
      gitWatch: (on: unknown) => { watching = on === true; return rewatch(); },
      gitLog: log,
      gitUnpublished: unpublished,
      gitCommitDetails: commitDetails,
      gitPatch: patch,
      gitBranches: branches,
      gitTags: tags,
      gitRemotes: remotes,
      gitStashes: stashes,
      gitFileAt: fileAt,
      gitBlame: blame,
      gitIdentity: identity,
      gitLastMessage: lastMessage,
      gitOutgoing: outgoing,
      gitProtection: (value: unknown) => { protection = protectionFrom(value); context.send('git:changed', null); },
      gitRun: (action: GlistGitAction, root?: unknown) => exclusive(() => act(action, root).catch(failure)),
      gitClone: (address: unknown, folder: unknown) => clone(address, folder).catch(failure),
    },
    // The project changed.
    projectChanged: (): Promise<void> => rewatch(),
    // Whether a remote's branch is protected, for updates of the engine and plugins.
    protects: (folder: string, remote: string, branch: string): Promise<boolean> => isProtected(folder, remote, branch, true),
    blobAt,
    stop: stopWatching,
  };
};
