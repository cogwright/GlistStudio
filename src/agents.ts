import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, promises as fs, readdirSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Coding agents the Agent tab runs: command-line programs with their own
// terminal interface. Each is looked for in Glist Studio's folder (installed
// from Settings), then in what Glist ships, then on PATH.

export type AgentId = 'claude' | 'codex' | 'gemini' | 'antigravity';

interface AgentDefinition {
  id: AgentId;
  name: string;
  // Its command on PATH.
  command: string;
  // The npm package Settings installs; Antigravity has only a system-wide installer.
  npmPackage?: string;
  // Where it keeps its settings and sign-in, when installed from Settings.
  configVariable?: string;
}

export const agentDefinitions: AgentDefinition[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', npmPackage: '@anthropic-ai/claude-code', configVariable: 'CLAUDE_CONFIG_DIR' },
  { id: 'codex', name: 'Codex', command: 'codex', npmPackage: '@openai/codex', configVariable: 'CODEX_HOME' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', npmPackage: '@google/gemini-cli', configVariable: 'GEMINI_CLI_HOME' },
  { id: 'antigravity', name: 'Antigravity', command: 'agy' },
];

export const isAgentId = (value: unknown): value is AgentId => agentDefinitions.some((agent) => agent.id === value);

// Where to look: Glist Studio's folder, the Glist folder, and the PATH the
// terminal gets.
export interface AgentPlaces {
  home: string;
  glist: string;
  searchPath: string;
}

export interface AgentLaunch {
  file: string;
  args: string[];
  // Put before PATH, so the agent finds the Node.js it was installed with.
  pathPrefix: string[];
  env?: Record<string, string>;
}

type AgentSource = 'studio' | 'glist' | 'system';

const windows = process.platform === 'win32';

// The Node.js runtime Settings downloads into Glist Studio's folder.
const runtimeDirectory = (home: string): string => path.join(home, 'runtime', 'node');
const runtimeBin = (home: string): string => (windows ? runtimeDirectory(home) : path.join(runtimeDirectory(home), 'bin'));
const runtimeNode = (home: string): string => path.join(runtimeBin(home), windows ? 'node.exe' : 'node');
const runtimeNpm = (home: string): string => (windows
  ? path.join(runtimeDirectory(home), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : path.join(runtimeDirectory(home), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
const agentsDirectory = (home: string): string => path.join(home, 'agents');

// Places a program installed for one user may be in, which an app started
// from the desktop does not always have on its PATH.
const userBinDirectories = (): string[] => (windows
  ? [path.join(process.env.APPDATA ?? '', 'npm')]
  : [path.join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']);

const findOnPath = (command: string, searchPath: string): string | null => {
  const extensions = windows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  const directories = [...searchPath.split(path.delimiter), ...userBinDirectories()].filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
};

// The script an npm package runs as its command, from its package.json.
const packageEntry = async (packageDirectory: string, command: string): Promise<string | null> => {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[command] ?? Object.values(manifest.bin ?? {})[0];
    const entry = bin && path.join(packageDirectory, bin);
    return entry && existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
};

// Whether an npm command is a Node.js script; some packages, such as Claude
// Code's, install a native program as their command instead.
const isNodeScript = async (file: string): Promise<boolean> => {
  if (/\.(c|m)?js$/i.test(file)) return true;
  const handle = await fs.open(file, 'r').catch((): null => null);
  if (!handle) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(128), 0, 128, 0);
    const start = buffer.subarray(0, bytesRead).toString('latin1');
    return start.startsWith('#!') && /node/.test(start.split('\n')[0]);
  } finally {
    await handle.close();
  }
};

// Glist's zbin carries Gemini CLI: ready to run with its own node.exe on
// Windows, and installed by zbin's gemini.sh on first use on macOS.
const glistGemini = (glist: string): { entry: string; node?: string } | null => {
  let zbins: string[] = [];
  try { zbins = readdirSync(path.join(glist, 'zbin')); } catch { return null; }
  for (const zbin of zbins) {
    const folder = path.join(glist, 'zbin', zbin, 'gemini');
    const entry = path.join(folder, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    if (!existsSync(entry)) continue;
    const bundledNode = path.join(folder, windows ? 'node.exe' : 'node');
    return { entry, node: existsSync(bundledNode) ? bundledNode : undefined };
  }
  return null;
};

// A Node.js to run npm-installed agents with: Glist Studio's own, else the system's.
const nodeFor = (places: AgentPlaces): string | null =>
  (existsSync(runtimeNode(places.home)) ? runtimeNode(places.home) : findOnPath('node', places.searchPath));

const locate = async (agent: AgentDefinition, places: AgentPlaces): Promise<{ source: AgentSource; launch: AgentLaunch } | null> => {
  if (agent.npmPackage) {
    const entry = await packageEntry(path.join(agentsDirectory(places.home), 'node_modules', agent.npmPackage), agent.command);
    const node = nodeFor(places);
    // One installed from Settings keeps its settings and sign-in in the Glist folder too.
    const env = agent.configVariable ? { [agent.configVariable]: path.join(agentsDirectory(places.home), 'config', agent.id) } : undefined;
    if (entry && !(await isNodeScript(entry))) return { source: 'studio', launch: { file: entry, args: [], pathPrefix: [path.dirname(entry)], env } };
    if (entry && node) return { source: 'studio', launch: { file: node, args: [entry], pathPrefix: [path.dirname(node)], env } };
  }
  if (agent.id === 'gemini') {
    const bundled = glistGemini(places.glist);
    const node = bundled?.node ?? nodeFor(places);
    if (bundled && node) return { source: 'glist', launch: { file: node, args: [bundled.entry], pathPrefix: [path.dirname(node)] } };
  }
  const found = findOnPath(agent.command, places.searchPath);
  if (!found) return null;
  // npm's command shims on Windows are batch files, which only cmd.exe runs.
  const launch = windows && /\.(cmd|bat)$/i.test(found)
    ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', found], pathPrefix: [path.dirname(found)] }
    : { file: found, args: [], pathPrefix: [path.dirname(found)] };
  return { source: 'system', launch };
};

export interface AgentStatus {
  id: AgentId;
  name: string;
  installed: boolean;
  source?: AgentSource;
  location?: string;
  installable: boolean;
}

export const findAgents = async (places: AgentPlaces): Promise<AgentStatus[]> => Promise.all(agentDefinitions.map(async (agent) => {
  const found = await locate(agent, places);
  return {
    id: agent.id,
    name: agent.name,
    installed: Boolean(found),
    source: found?.source,
    location: found ? [found.launch.file, ...found.launch.args].pop() : undefined,
    installable: Boolean(agent.npmPackage),
  };
}));

export const agentLaunch = async (id: AgentId, places: AgentPlaces): Promise<AgentLaunch | null> => {
  const agent = agentDefinitions.find((candidate) => candidate.id === id);
  return agent ? (await locate(agent, places))?.launch ?? null : null;
};

const run = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, report: (text: string) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, windowsHide: true });
    child.stdout.on('data', (chunk: Buffer) => report(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => report(chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} ${args[0] ?? ''} stopped with code ${code}`))));
  });

// The current Node.js 24 release for this computer, from nodejs.org, checked
// against the release's SHA-256 list and unpacked into Glist Studio's folder.
const installRuntime = async (home: string, report: (text: string) => void): Promise<void> => {
  if (existsSync(runtimeNode(home)) && existsSync(runtimeNpm(home))) return;
  const release = 'https://nodejs.org/dist/latest-v24.x/';
  const platform = windows ? 'win' : process.platform;
  const extension = windows ? 'zip' : 'tar.gz';
  const sums = await fetch(`${release}SHASUMS256.txt`).then((response) => {
    if (!response.ok) throw new Error(`nodejs.org: ${response.status}`);
    return response.text();
  });
  const line = sums.split('\n').find((candidate) => candidate.trim().endsWith(`-${platform}-${process.arch}.${extension}`));
  if (!line) throw new Error(`nodejs.org has no Node.js for ${platform}-${process.arch}`);
  const [expected, file] = line.trim().split(/\s+/);
  const runtimeRoot = path.dirname(runtimeDirectory(home));
  await fs.mkdir(runtimeRoot, { recursive: true });
  const archive = path.join(runtimeRoot, file);
  report(`Downloading ${file}\n`);
  const response = await fetch(release + file);
  if (!response.ok || !response.body) throw new Error(`nodejs.org: ${response.status}`);
  const hash = createHash('sha256');
  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  let reported = 0;
  const output = createWriteStream(archive);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    received += chunk.length;
    if (!output.write(chunk)) await new Promise<void>((resolve) => output.once('drain', () => resolve()));
    if (total && received / total >= reported + 0.25) {
      reported = Math.floor((received / total) * 4) / 4;
      report(`  ${Math.round(reported * 100)}%\n`);
    }
  }
  await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
  if (hash.digest('hex') !== expected) {
    await fs.rm(archive, { force: true });
    throw new Error(`${file} does not match its SHA-256 on nodejs.org`);
  }
  // Windows 10 and later have bsdtar, which unpacks zip files too.
  const tar = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  await run(tar, ['-xf', archive, '-C', runtimeRoot], {}, report);
  await fs.rm(runtimeDirectory(home), { recursive: true, force: true });
  await fs.rename(path.join(runtimeRoot, file.replace(/\.(zip|tar\.gz)$/, '')), runtimeDirectory(home));
  await fs.rm(archive, { force: true });
};

// npm leaves node-pty's prebuilt helper without its execute bit, so agents that
// run commands in a terminal of their own fail with "posix_spawnp failed".
const restoreSpawnHelpers = async (directory: string): Promise<void> => {
  if (windows) return;
  const entries = await fs.readdir(directory, { withFileTypes: true, recursive: true }).catch((): Dirent[] => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name === 'spawn-helper')
    .map((entry) => fs.chmod(path.join(entry.parentPath, entry.name), 0o755).catch((): undefined => undefined)));
};

// Installs an agent from npm into Glist Studio's folder, with a Node.js of its
// own. Nothing is written outside that folder: npm's cache is kept there too.
export const installAgent = async (id: AgentId, places: AgentPlaces, report: (text: string) => void): Promise<void> => {
  const agent = agentDefinitions.find((candidate) => candidate.id === id);
  if (!agent?.npmPackage) throw new Error(`${agent?.name ?? id} cannot be installed from here`);
  await installRuntime(places.home, report);
  const directory = agentsDirectory(places.home);
  await fs.mkdir(directory, { recursive: true });
  report(`Installing ${agent.npmPackage}\n`);
  await run(runtimeNode(places.home), [
    runtimeNpm(places.home), 'install', '--prefix', directory, '--no-audit', '--no-fund', '--loglevel=error', `${agent.npmPackage}@latest`,
  ], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: [runtimeBin(places.home), places.searchPath].join(path.delimiter),
      npm_config_cache: path.join(places.home, 'runtime', 'npm-cache'),
      // Where node-gyp would put Node.js headers, if a package had to compile something.
      npm_config_devdir: path.join(places.home, 'runtime', 'node-gyp'),
      npm_config_update_notifier: 'false',
    },
  }, report);
  await restoreSpawnHelpers(path.join(directory, 'node_modules'));
  await fs.rm(path.join(places.home, 'runtime', 'npm-cache'), { recursive: true, force: true });
};
