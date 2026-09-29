import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs, renameSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

// New versions of Glist Studio from its published GitHub releases, and the
// ways each platform's installer takes the running app's place. Nothing here
// needs Electron, so it can be tested on its own. A release stays a draft,
// invisible here, until someone publishes it.

const run = promisify(execFile);
const userAgent = 'Glist Studio';

export interface ReleaseSource {
  // https://github.com and https://api.github.com, or a test server.
  site: string;
  api: string;
  repository: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  // "sha256:<hex>", as GitHub reports it.
  digest?: string;
  size: number;
}

export interface Release {
  version: string;
  page: string;
  assets: ReleaseAsset[];
}

const numbers = (version: string): number[] =>
  version.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);

// Whether a version is newer than another, by major, minor and patch; with
// those equal, a release is newer than its own prereleases.
export const isNewer = (candidate: string, current: string): boolean => {
  const [next, now] = [numbers(candidate), numbers(current)];
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] ?? 0) !== (now[index] ?? 0)) return (next[index] ?? 0) > (now[index] ?? 0);
  }
  // 0.0.4 after 0.0.4-dev.12, which main's prereleases are numbered like.
  const prerelease = (version: string): boolean => version.replace(/^v/, '').split('+')[0].includes('-');
  return prerelease(current) && !prerelease(candidate);
};

// The tag of the latest published release, from where github.com sends
// /releases/latest. That page is not rate limited the way the API is, so a
// classroom of computers behind one address can all check at once; the API is
// only asked about a release that is newer.
export const latestTag = async (source: ReleaseSource): Promise<string | null> => {
  const response = await fetch(`${source.site}/${source.repository}/releases/latest`, {
    method: 'HEAD', headers: { 'User-Agent': userAgent },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(response.url)?.[1];
  return tag ? decodeURIComponent(tag) : null;
};

export const releaseAt = async (source: ReleaseSource, tag: string): Promise<Release> => {
  const response = await fetch(`${source.api}/repos/${source.repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release = await response.json() as {
    tag_name: string;
    html_url: string;
    assets?: Array<{ name: string; browser_download_url: string; digest?: string | null; size: number }>;
  };
  return {
    version: release.tag_name.replace(/^v/, ''),
    page: release.html_url,
    assets: (release.assets ?? []).map((asset) => ({
      name: asset.name, url: asset.browser_download_url, digest: asset.digest ?? undefined, size: asset.size,
    })),
  };
};

// The installer this computer takes, as the release workflow names them: the
// universal disk image on macOS, the setup program for the processor on
// Windows, and the AppImage for the processor on Linux.
export const assetFor = (assets: ReleaseAsset[], platform: NodeJS.Platform, arch: string): ReleaseAsset | undefined => {
  const linuxArch: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' };
  const ending = platform === 'darwin' ? '-macos-universal.dmg'
    : platform === 'win32' ? `-windows-${arch}-setup.exe`
      : platform === 'linux' ? `-linux-${linuxArch[arch] ?? arch}.AppImage` : null;
  return ending ? assets.find((asset) => asset.name.endsWith(ending)) : undefined;
};

const fileHash = (file: string): Promise<string> => new Promise((resolve) => {
  const hash = createHash('sha256');
  createReadStream(file)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolve(hash.digest('hex')))
    .on('error', () => resolve(''));
});

// Downloads an installer and checks it against the SHA-256 GitHub keeps for
// it. One without a checksum is refused, and one already downloaded is kept.
export const download = async (asset: ReleaseAsset, file: string, progress?: (fraction: number) => void): Promise<void> => {
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase();
  if (!expected) throw new Error(`${asset.name} has no checksum on GitHub`);
  if (await fileHash(file) === expected) return;
  const partial = `${file}.part`;
  try {
    const response = await fetch(asset.url, { headers: { 'User-Agent': userAgent } });
    if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status}`);
    const hash = createHash('sha256');
    const output = createWriteStream(partial);
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        received += chunk.length;
        if (!output.write(chunk)) await new Promise<void>((resolve) => output.once('drain', () => resolve()));
        if (asset.size) progress?.(received / asset.size);
      }
    } finally {
      await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
    }
    if (hash.digest('hex') !== expected) throw new Error(`${asset.name} does not match its checksum on GitHub`);
    await fs.rename(partial, file);
  } finally {
    await fs.rm(partial, { force: true });
  }
};

// The app in a downloaded disk image, copied out beside it, ready to take the
// running app's place. It must be the version the release says it is.
export const stageMacApp = async (image: string, version: string): Promise<string> => {
  const folder = path.dirname(image);
  const mount = await fs.mkdtemp(path.join(folder, 'mount-'));
  let staged = '';
  try {
    await run('hdiutil', ['attach', image, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
    const bundle = (await fs.readdir(mount)).find((name) => name.endsWith('.app'));
    if (!bundle) throw new Error('The disk image has no app in it');
    staged = path.join(folder, bundle);
    await fs.rm(staged, { recursive: true, force: true });
    await run('ditto', [path.join(mount, bundle), staged]);
  } finally {
    await run('hdiutil', ['detach', mount, '-force']).catch((): undefined => undefined);
    await fs.rm(mount, { recursive: true, force: true }).catch((): undefined => undefined);
  }
  // Checked against GitHub's checksum above; macOS need not ask about it again.
  await run('xattr', ['-dr', 'com.apple.quarantine', staged]).catch((): undefined => undefined);
  const { stdout } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(staged, 'Contents', 'Info.plist')]);
  if (stdout.trim() !== version) throw new Error(`The disk image holds version ${stdout.trim()}, not ${version}`);
  return staged;
};

// Waits for the app to quit, puts the new bundle where the old one was, and
// opens it if asked. When the new one cannot be moved in, the old one goes back.
const macSwap = `
pid=$1 bundle=$2 staged=$3 relaunch=$4
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$bundle.previous"
rm -rf "$old"
if mv "$bundle" "$old"; then
  if mv "$staged" "$bundle"; then rm -rf "$old"; else mv "$old" "$bundle"; fi
fi
if [ -n "$relaunch" ]; then open "$bundle"; fi
`;

export const installMacApp = (staged: string, bundle: string, pid: number, relaunch: boolean): void => {
  spawn('/bin/sh', ['-c', macSwap, 'glist-studio-update', String(pid), bundle, staged, relaunch ? '1' : ''], {
    detached: true, stdio: 'ignore',
  }).unref();
};

// Squirrel's setup program over an installed app is an update: it installs the
// new version beside the old one and starts it.
export const runWindowsSetup = (setup: string): void => {
  spawn(setup, [], { detached: true, stdio: 'ignore' }).unref();
};

// The new AppImage was downloaded beside the running one, so one rename puts it
// in place; the running one keeps working from the file it already opened.
export const replaceAppImage = (staged: string, target: string, relaunch: boolean): void => {
  renameSync(staged, target);
  if (relaunch) spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
};
