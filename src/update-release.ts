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
  // A preview: GitHub's prerelease.
  preview?: boolean;
}

const numbers = (version: string): number[] =>
  version.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);

// What follows the dash: dev.12 in 0.0.4-dev.12, as main's prereleases are numbered.
const prereleaseOf = (version: string): string => {
  const core = version.replace(/^v/, '').split('+')[0];
  const dash = core.indexOf('-');
  return dash < 0 ? '' : core.slice(dash + 1);
};

// Two prereleases of the same version, by SemVer's rules: part by part,
// numbers as numbers and before words, and fewer parts before more.
const comparePrereleases = (left: string, right: string): number => {
  const [a, b] = [left.split('.'), right.split('.')];
  const numeric = /^\d+$/;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (numeric.test(a[index]) && numeric.test(b[index])) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference !== 0) return Math.sign(difference);
    } else if (numeric.test(a[index]) !== numeric.test(b[index])) return numeric.test(a[index]) ? -1 : 1;
    else if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
};

// Whether a version is newer than another, by major, minor and patch; with
// those equal, a release is newer than its own prereleases, and a later
// prerelease newer than an earlier one: 0.0.4 after 0.0.4-dev.12 after 0.0.4-dev.2.
export const isNewer = (candidate: string, current: string): boolean => {
  const [next, now] = [numbers(candidate), numbers(current)];
  for (let index = 0; index < 3; index += 1) {
    if ((next[index] ?? 0) !== (now[index] ?? 0)) return (next[index] ?? 0) > (now[index] ?? 0);
  }
  const [nextPre, nowPre] = [prereleaseOf(candidate), prereleaseOf(current)];
  if (!nowPre) return false;
  return !nextPre || comparePrereleases(nextPre, nowPre) > 0;
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

// Releases, previews included, from the repository's releases feed, newest
// first: like /releases/latest it is not rate limited the way the API is.
export const feedTags = async (source: ReleaseSource): Promise<string[]> => {
  const response = await fetch(`${source.site}/${source.repository}/releases.atom`, { headers: { 'User-Agent': userAgent } });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const tags = [...(await response.text()).matchAll(/\/releases\/tag\/([^"<>\s/?#]+)/g)].map((match) => decodeURIComponent(match[1]));
  return [...new Set(tags)].sort((left, right) => (isNewer(left, right) ? -1 : isNewer(right, left) ? 1 : 0));
};

// A release as the API shows it, or null for one it does not show to everyone:
// a draft, which a version tag's build makes before someone publishes it.
export const releaseAt = async (source: ReleaseSource, tag: string): Promise<Release | null> => {
  const response = await fetch(`${source.api}/repos/${source.repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return fromApi(await response.json() as ApiRelease);
};

interface ApiRelease {
  tag_name: string;
  html_url: string;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string; digest?: string | null; size: number }>;
}
const fromApi = (release: ApiRelease): Release => ({
  version: release.tag_name.replace(/^v/, ''),
  page: release.html_url,
  preview: Boolean(release.prerelease),
  assets: (release.assets ?? []).map((asset) => ({
    name: asset.name, url: asset.browser_download_url, digest: asset.digest ?? undefined, size: asset.size,
  })),
});

// The published releases, newest first, as the API lists them; for rolling
// back, asked only when someone wants to. Drafts are not shown to anyone else.
export const releases = async (source: ReleaseSource): Promise<Release[]> => {
  const response = await fetch(`${source.api}/repos/${source.repository}/releases?per_page=50`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return ((await response.json()) as ApiRelease[]).map(fromApi)
    .sort((left, right) => (isNewer(left.version, right.version) ? -1 : isNewer(right.version, left.version) ? 1 : 0));
};

// The versions before this one that it can go back to, newest first: releases,
// and previews too when previews are chosen or this is one. A version already
// on the computer (kept) is offered even when GitHub no longer lists it near
// the top; one this computer cannot install itself goes to its release page.
export const rollbackChoices = (
  listed: Release[], current: string, previews: boolean, kept: string[],
  installable: (version: string, release: Release | null, kept: boolean) => boolean,
): GlistRollbackChoice[] => {
  const withPreviews = previews || prereleaseOf(current) !== '';
  const older = listed.filter((release) => isNewer(current, release.version) && (withPreviews || !release.preview)).slice(0, 15);
  const keptOnly = kept.filter((version) => isNewer(current, version) && !older.some((release) => release.version === version));
  return [...older.map((release) => ({ version: release.version, preview: Boolean(release.preview), page: release.page })),
    ...keptOnly.map((version) => ({ version, preview: prereleaseOf(version) !== '', page: '' }))]
    .sort((left, right) => (isNewer(left.version, right.version) ? -1 : 1))
    .map((choice) => {
      const isKept = kept.includes(choice.version);
      return { ...choice, kept: isKept, installable: installable(choice.version, listed.find((release) => release.version === choice.version) ?? null, isKept) };
    });
};

// After rolling back from a version, that version and those before it are not
// installed again by themselves; a newer one is.
export const heldBack = (version: string, held: string | null): boolean => Boolean(held) && !isNewer(version, held as string);

// The newest release after this version that can be downloaded: the latest
// published one, or with previews the newest in the feed. The feed lists a
// draft's tag too, which leads nowhere yet, so the next newest is taken instead.
export const newerRelease = async (source: ReleaseSource, current: string, previews: boolean): Promise<Release | null> => {
  const tags = previews ? await feedTags(source) : [await latestTag(source)];
  for (const tag of tags.filter((each): each is string => Boolean(each) && isNewer(each as string, current)).slice(0, 5)) {
    const release = await releaseAt(source, tag);
    if (release) return release;
  }
  return null;
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
// opens it if asked. When the new one cannot be moved in, the old one goes
// back. The old one is kept where asked, to roll back to; otherwise removed.
const macSwap = `
pid=$1 bundle=$2 staged=$3 relaunch=$4 keep=$5
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
old="$bundle.previous"
rm -rf "$old"
if mv "$bundle" "$old"; then
  if mv "$staged" "$bundle"; then
    if [ -n "$keep" ]; then mkdir -p "$(dirname "$keep")"; rm -rf "$keep"; mv "$old" "$keep" || rm -rf "$old"; else rm -rf "$old"; fi
  else mv "$old" "$bundle"; fi
fi
if [ -n "$relaunch" ]; then open "$bundle"; fi
`;

export const installMacApp = (staged: string, bundle: string, pid: number, relaunch: boolean, keep = ''): void => {
  spawn('/bin/sh', ['-c', macSwap, 'glist-studio-update', String(pid), bundle, staged, relaunch ? '1' : '', keep], {
    detached: true, stdio: 'ignore',
  }).unref();
};

// A kept app copied out to take the running app's place, the kept one staying
// for another time. It must be the version it was kept as.
export const stageKeptMacApp = async (kept: string, version: string, folder: string): Promise<string> => {
  await fs.mkdir(folder, { recursive: true });
  const staged = path.join(folder, path.basename(kept));
  await fs.rm(staged, { recursive: true, force: true });
  await run('ditto', [kept, staged]);
  const { stdout } = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(staged, 'Contents', 'Info.plist')]);
  if (stdout.trim() !== version) throw new Error(`The kept app is version ${stdout.trim()}, not ${version}`);
  return staged;
};

// Squirrel's setup program over an installed app is an update: it installs the
// new version beside the old one and starts it.
export const runWindowsSetup = (setup: string): void => {
  spawn(setup, [], { detached: true, stdio: 'ignore' }).unref();
};

// The new AppImage was downloaded beside the running one, so one rename puts it
// in place; the running one keeps working from the file it already opened. The
// old one is renamed aside first when asked, beside it, to roll back to.
export const replaceAppImage = (staged: string, target: string, relaunch: boolean, keep = ''): void => {
  if (keep) {
    try { renameSync(target, keep); } catch { /* Then it is not kept. */ }
  }
  renameSync(staged, target);
  if (relaunch) spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
};

// The AppImages kept beside the running one, by version: .<name>.<version>.
export const keptAppImage = (target: string, version: string): string =>
  path.join(path.dirname(target), `.${path.basename(target)}.${version}`);

// Squirrel compares the prerelease parts of two versions as text, so a folder
// app-0.0.9-dev6 came after app-0.0.9-dev16 and an update started the version
// before it. A preview is packaged for Squirrel as pre and its number in four
// digits (forge.config.ts): text order is then number order, and pre comes
// after the dev of the packages made before.
export const squirrelPackageVersion = (version: string): string =>
  version.replace(/-dev\.(\d+)$/, (_, number: string) => `-pre${number.padStart(4, '0')}`);

// The version in a Squirrel app-<version> folder's name, either way it was
// packaged: app-0.0.9-pre0017 and, before, app-0.0.9-dev17 (electron-winstaller
// takes the dots out of a prerelease) both hold 0.0.9-dev.17.
export const squirrelVersion = (folder: string): string => {
  const version = folder.replace(/^app-/, '');
  const packaged = /^(\d+\.\d+\.\d+)-pre(\d+)$/.exec(version);
  return packaged ? `${packaged[1]}-dev.${Number(packaged[2])}` : version.replace(/^(\d+\.\d+\.\d+-[A-Za-z]+)(\d+)$/, '$1.$2');
};

// Whether Squirrel starts the app in one folder rather than another: the higher
// x.y.z, a release before its prereleases, and of two prereleases the one later
// as text, case aside (NuGet's ordering).
export const squirrelPrefers = (folder: string, other: string): boolean => {
  const parts = (name: string): [number[], string] => {
    const [core, ...rest] = name.replace(/^app-/, '').split('-');
    return [core.split('.').map((part) => Number(part) || 0), rest.join('-').toLowerCase()];
  };
  const [[numbers, pre], [otherNumbers, otherPre]] = [parts(folder), parts(other)];
  for (let index = 0; index < Math.max(numbers.length, otherNumbers.length); index += 1) {
    if ((numbers[index] ?? 0) !== (otherNumbers[index] ?? 0)) return (numbers[index] ?? 0) > (otherNumbers[index] ?? 0);
  }
  if (!pre || !otherPre) return !pre && Boolean(otherPre);
  return pre > otherPre;
};

// Squirrel starts the app-<version> folder it prefers there. Going back renames
// every other one, once the app has quit, to a name Squirrel passes over, so it
// can only start the one chosen: renames either happen or do not, never a
// folder half deleted.
export const rollBackSquirrel = (root: string, setAside: string[], executable: string, pid: number, relaunch: boolean): void => {
  const quoted = (text: string): string => `'${text.replace(/'/g, "''")}'`;
  const script = [
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    ...setAside.map((folder) => `Rename-Item -LiteralPath ${quoted(path.join(root, folder))} -NewName ${quoted(`rolled-back-${folder.replace(/^app-/, '')}`)}`),
    relaunch ? `Start-Process -FilePath ${quoted(path.join(root, 'Update.exe'))} -ArgumentList '--processStart', ${quoted(`"${executable}"`)}` : '',
  ].filter(Boolean).join('; ');
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
};
