import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assetFor, download, feedTags, heldBack, installMacApp, isNewer, keptAppImage, latestTag, newerRelease, releaseAt, releases, replaceAppImage,
  rollbackChoices, squirrelPackageVersion, squirrelPrefers, squirrelVersion, stageKeptMacApp, stageMacApp,
} from '../src/update-release.ts';

// Updating from GitHub releases, against a local server that answers as
// github.com and its API do. Run with jiti.
const root = mkdtempSync(path.join(tmpdir(), 'glist-update-'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

assert.equal(isNewer('v0.0.2', '0.0.1'), true);
assert.equal(isNewer('0.1.0', '0.0.9'), true);
assert.equal(isNewer('1.0.0', '1.0.0'), false);
assert.equal(isNewer('v0.0.1', '0.1.0'), false);
assert.equal(isNewer('0.10.0', '0.9.3'), true, 'compared as numbers, not text');
assert.equal(isNewer('v0.0.4', '0.0.4-dev.12'), true, 'a release after its prereleases');
assert.equal(isNewer('v0.0.4', '0.0.5-dev.1'), false);
assert.equal(isNewer('v0.0.3', '0.0.4-dev.1'), false);
assert.equal(isNewer('v0.0.4', '0.0.4'), false);
// Previews among themselves, by SemVer: dev.12 after dev.2, and a release after both.
assert.equal(isNewer('v0.0.5-dev.12', '0.0.5-dev.2'), true);
assert.equal(isNewer('v0.0.5-dev.2', '0.0.5-dev.12'), false);
assert.equal(isNewer('v0.0.5-dev.2', '0.0.5-dev.2'), false);
assert.equal(isNewer('v0.0.5-dev.1', '0.0.4'), true, 'a preview of the next version after this release');
assert.equal(isNewer('v0.0.5-beta', '0.0.5-alpha'), true);
assert.equal(isNewer('v0.0.5-dev.1.1', '0.0.5-dev.1'), true);

const names = [
  'Glist-Studio-0.0.3-linux-aarch64.AppImage', 'Glist-Studio-0.0.3-linux-x86_64.AppImage', 'Glist-Studio-0.0.3-macos-universal.dmg',
  'Glist-Studio-0.0.3-windows-arm64-setup.exe', 'Glist-Studio-0.0.3-windows-x64-setup.exe',
];
const assets = names.map((name) => ({ name, url: '', size: 1 }));
assert.equal(assetFor(assets, 'darwin', 'arm64')?.name, 'Glist-Studio-0.0.3-macos-universal.dmg');
assert.equal(assetFor(assets, 'win32', 'arm64')?.name, 'Glist-Studio-0.0.3-windows-arm64-setup.exe');
assert.equal(assetFor(assets, 'win32', 'x64')?.name, 'Glist-Studio-0.0.3-windows-x64-setup.exe');
assert.equal(assetFor(assets, 'linux', 'x64')?.name, 'Glist-Studio-0.0.3-linux-x86_64.AppImage');
assert.equal(assetFor(assets, 'linux', 'arm64')?.name, 'Glist-Studio-0.0.3-linux-aarch64.AppImage');
assert.equal(assetFor(assets, 'win32', 'ia32'), undefined);

const installer = Buffer.from('the new installer\n');
const requests = [];
let latest = 'v0.0.3';
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const base = `http://127.0.0.1:${server.address().port}`;
  if (request.url === '/owner/repo/releases/latest') {
    response.writeHead(302, { Location: latest ? `/owner/repo/releases/tag/${latest}` : '/owner/repo/releases' });
    response.end();
  } else if (request.url === '/owner/repo/releases.atom') {
    // Previews and releases alike, and v0.0.6, whose release is still a draft.
    response.writeHead(200, { 'Content-Type': 'application/atom+xml' });
    response.end(['v0.0.6', 'v0.0.5-dev.2', 'v0.0.5-dev.12', 'v0.0.4', 'v0.0.5-dev.1', 'v0.0.5-dev.12'].map((tag) =>
      `<entry><link rel="alternate" type="text/html" href="${base}/owner/repo/releases/tag/${tag}"/></entry>`).join(''));
  } else if (request.url === '/api/repos/owner/repo/releases?per_page=50') {
    // The API's list, in no particular order: drafts are not in it for anyone else.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(['v0.0.4', 'v0.0.5-dev.12', 'v0.0.3', 'v0.0.5-dev.2', 'v0.0.2'].map((tag) => ({
      tag_name: tag, html_url: `${base}/owner/repo/releases/tag/${tag}`, prerelease: tag.includes('-dev'),
      assets: tag === 'v0.0.2' ? [] : [{ name: `Glist-Studio-${tag.slice(1)}-macos-universal.dmg`, browser_download_url: `${base}/x`, digest: null, size: 1 }],
    }))));
  } else if (request.url.startsWith('/owner/repo/releases')) {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(request.method === 'HEAD' ? undefined : '<html></html>');
  } else if (request.url === '/api/repos/owner/repo/releases/tags/v0.0.5-dev.12') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ tag_name: 'v0.0.5-dev.12', html_url: `${base}/owner/repo/releases/tag/v0.0.5-dev.12`, assets: [] }));
  } else if (request.url === '/api/repos/owner/repo/releases/tags/v0.0.3') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      tag_name: 'v0.0.3',
      html_url: `${base}/owner/repo/releases/tag/v0.0.3`,
      assets: [
        { name: 'good.exe', browser_download_url: `${base}/download/good`, digest: `sha256:${sha256(installer)}`, size: installer.length },
        { name: 'bad.exe', browser_download_url: `${base}/download/good`, digest: `sha256:${'0'.repeat(64)}`, size: installer.length },
        { name: 'unchecked.exe', browser_download_url: `${base}/download/good`, digest: null, size: installer.length },
      ],
    }));
  } else if (request.url === '/download/good') {
    response.writeHead(200, { 'Content-Length': installer.length });
    response.end(installer);
  } else {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const source = { site: base, api: `${base}/api`, repository: 'owner/repo' };

try {
  assert.equal(await latestTag(source), 'v0.0.3');
  assert.deepEqual(await feedTags(source), ['v0.0.6', 'v0.0.5-dev.12', 'v0.0.5-dev.2', 'v0.0.5-dev.1', 'v0.0.4'], 'newest first, previews included');
  // A draft's tag in the feed is passed over for the newest release that can be downloaded.
  assert.equal(await releaseAt(source, 'v0.0.6'), null, 'a draft is not shown');
  assert.equal((await newerRelease(source, '0.0.4', true))?.version, '0.0.5-dev.12');
  assert.equal((await newerRelease(source, '0.0.2', false))?.version, '0.0.3', 'without previews, the latest published release');
  assert.equal(await newerRelease(source, '0.0.3', false), null, 'up to date');
  assert.equal(await newerRelease(source, '0.0.5-dev.12', true), null, 'nothing newer than this but the draft');
  latest = '';
  assert.equal(await latestTag(source), null, 'no published release yet');
  latest = 'v0.0.3';

  // Going back: the published releases newest first, then the ones before this
  // version, previews only when asked for or when this is one, and a version
  // kept on the computer even when GitHub no longer lists it near the top.
  const listed = await releases(source);
  assert.deepEqual(listed.map((release) => `${release.version}${release.preview ? ' preview' : ''}`),
    ['0.0.5-dev.12 preview', '0.0.5-dev.2 preview', '0.0.4', '0.0.3', '0.0.2']);
  const installable = (version, release, kept) => kept || Boolean(release?.assets.length);
  const choices = (current, previews, kept = []) => rollbackChoices(listed, current, previews, kept, installable)
    .map((choice) => `${choice.version}${choice.preview ? ' preview' : ''}${choice.kept ? ' kept' : ''}${choice.installable ? '' : ' page'}`);
  assert.deepEqual(choices('0.0.5', false), ['0.0.4', '0.0.3', '0.0.2 page'], 'releases only');
  assert.deepEqual(choices('0.0.5', true), ['0.0.5-dev.12 preview', '0.0.5-dev.2 preview', '0.0.4', '0.0.3', '0.0.2 page']);
  assert.deepEqual(choices('0.0.5-dev.12', false), ['0.0.5-dev.2 preview', '0.0.4', '0.0.3', '0.0.2 page'], 'on a preview, the previews before it');
  assert.deepEqual(choices('0.0.4', false, ['0.0.3', '0.0.1-dev.4']), ['0.0.3 kept', '0.0.2 page', '0.0.1-dev.4 preview kept']);
  assert.deepEqual(choices('0.0.2', true), [], 'nothing before the first');
  // Held after going back from 0.0.5: it and those before it wait, a newer one does not.
  assert.equal(heldBack('0.0.5', '0.0.5'), true);
  assert.equal(heldBack('0.0.5-dev.12', '0.0.5'), true);
  assert.equal(heldBack('0.0.6-dev.1', '0.0.5'), false);
  assert.equal(heldBack('0.0.5', null), false);
  // Squirrel's folders: a prerelease without its dots, as electron-winstaller names them.
  assert.equal(squirrelVersion('app-0.0.8-dev29'), '0.0.8-dev.29');
  assert.equal(squirrelVersion('app-0.0.7'), '0.0.7');
  assert.equal(squirrelVersion('app-1.2.3-beta'), '1.2.3-beta');
  // Squirrel orders prereleases as text, as it started app-0.0.9-dev6 over app-0.0.9-dev16;
  // previews are packaged as pre and four digits, whose text order is their number order.
  assert.equal(squirrelPrefers('app-0.0.9-dev6', 'app-0.0.9-dev16'), true, 'the order that started an older version');
  assert.equal(squirrelPackageVersion('0.0.9-dev.17'), '0.0.9-pre0017');
  assert.equal(squirrelPackageVersion('0.0.9'), '0.0.9');
  assert.equal(squirrelVersion('app-0.0.9-pre0017'), '0.0.9-dev.17');
  assert.equal(squirrelPrefers('app-0.0.9-pre0017', 'app-0.0.9-pre0006'), true);
  assert.equal(squirrelPrefers('app-0.0.9-pre0017', 'app-0.0.9-dev16'), true, 'after the dev packages made before');
  assert.equal(squirrelPrefers('app-0.0.9-pre0017', 'app-0.0.9-dev6'), true);
  assert.equal(squirrelPrefers('app-0.0.9', 'app-0.0.9-pre0017'), true, 'a release before its prereleases');
  assert.equal(squirrelPrefers('app-0.0.10-pre0001', 'app-0.0.9'), true);
  assert.equal(squirrelPrefers('app-0.0.8', 'app-0.0.9-pre0001'), false);

  const release = await releaseAt(source, 'v0.0.3');
  assert.equal(release.version, '0.0.3');
  assert.equal(release.assets.length, 3);
  const [good, bad, unchecked] = release.assets;

  const file = path.join(root, 'good.exe');
  const fractions = [];
  await download(good, file, (fraction) => fractions.push(fraction));
  assert.deepEqual(readFileSync(file), installer);
  assert.equal(fractions.at(-1), 1);
  const downloads = requests.filter((url) => url === '/download/good').length;
  await download(good, file);
  assert.equal(requests.filter((url) => url === '/download/good').length, downloads, 'a file already downloaded is kept');

  await assert.rejects(download(bad, path.join(root, 'bad.exe')), /does not match its checksum/);
  assert.equal(existsSync(path.join(root, 'bad.exe')), false);
  assert.equal(existsSync(path.join(root, 'bad.exe.part')), false, 'nothing is left behind');
  await assert.rejects(download(unchecked, path.join(root, 'unchecked.exe')), /has no checksum/);
  assert.equal(existsSync(path.join(root, 'unchecked.exe')), false);

  // A new AppImage takes the running one's place with one rename.
  const appImage = path.join(root, 'Glist-Studio.AppImage');
  writeFileSync(appImage, 'old');
  writeFileSync(`${appImage}.update`, 'new');
  replaceAppImage(`${appImage}.update`, appImage, false);
  assert.equal(readFileSync(appImage, 'utf8'), 'new');
  assert.equal(existsSync(`${appImage}.update`), false);
  // Asked to, the one it replaces is kept beside it, to go back to.
  writeFileSync(`${appImage}.update`, 'newer');
  replaceAppImage(`${appImage}.update`, appImage, false, keptAppImage(appImage, '0.0.2'));
  assert.equal(readFileSync(appImage, 'utf8'), 'newer');
  assert.equal(keptAppImage(appImage, '0.0.2'), path.join(root, '.Glist-Studio.AppImage.0.0.2'));
  assert.equal(readFileSync(keptAppImage(appImage, '0.0.2'), 'utf8'), 'new');

  if (process.platform === 'darwin') {
    // A disk image as the release workflow makes one: the app at its top.
    const makeApp = (folder, version) => {
      const contents = path.join(folder, 'Glist Studio.app', 'Contents');
      mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
      writeFileSync(path.join(contents, 'MacOS', 'gliststudio'), version);
      writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`);
    };
    const imageSource = path.join(root, 'image');
    makeApp(imageSource, '0.0.3');
    const updates = path.join(root, 'updates');
    mkdirSync(updates);
    const image = path.join(updates, 'Glist-Studio-0.0.3-macos-universal.dmg');
    execFileSync('hdiutil', ['create', '-quiet', '-srcfolder', imageSource, '-volname', 'Glist Studio', '-format', 'ULFO', image]);
    await assert.rejects(stageMacApp(image, '0.0.4'), /holds version 0.0.3, not 0.0.4/);
    const staged = await stageMacApp(image, '0.0.3');
    assert.equal(readFileSync(path.join(staged, 'Contents', 'MacOS', 'gliststudio'), 'utf8'), '0.0.3');
    assert.equal(execFileSync('hdiutil', ['info']).toString().includes(updates), false, 'the image is detached again');

    // The swap waits for the app to quit, then puts the new bundle in its place.
    const applications = path.join(root, 'Applications');
    makeApp(applications, '0.0.2');
    const bundle = path.join(applications, 'Glist Studio.app');
    const running = spawn('sleep', ['1']);
    installMacApp(staged, bundle, running.pid, false);
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    assert.equal(readFileSync(path.join(bundle, 'Contents', 'MacOS', 'gliststudio'), 'utf8'), '0.0.2', 'not while the app runs');
    await new Promise((resolve) => { running.once('exit', resolve); });
    const swapped = () => readFileSync(path.join(bundle, 'Contents', 'MacOS', 'gliststudio'), 'utf8') === '0.0.3';
    for (let tries = 0; tries < 50 && !swapped(); tries += 1) await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.ok(swapped(), 'the new app is in place');
    assert.equal(existsSync(staged), false);
    assert.equal(existsSync(`${bundle}.previous`), false, 'the old app is removed');

    // Kept, to go back to: the app it replaces goes where asked instead.
    const keep = path.join(updates, '0.0.3', 'Glist Studio.app');
    const later = path.join(root, 'later');
    makeApp(later, '0.0.4');
    const quitting = spawn('sleep', ['0.3']);
    installMacApp(path.join(later, 'Glist Studio.app'), bundle, quitting.pid, false, keep);
    await new Promise((resolve) => { quitting.once('exit', resolve); });
    const version = (app) => { try { return readFileSync(path.join(app, 'Contents', 'MacOS', 'gliststudio'), 'utf8'); } catch { return ''; } };
    for (let tries = 0; tries < 50 && version(keep) !== '0.0.3'; tries += 1) await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(version(bundle), '0.0.4', 'the newer app is in place');
    assert.equal(version(keep), '0.0.3', 'the one it replaced is kept');
    assert.equal(existsSync(`${bundle}.previous`), false);
    // Going back to it copies it out, the kept one staying; it must be the version it was kept as.
    await assert.rejects(stageKeptMacApp(keep, '0.0.2', path.join(updates, '0.0.3', 'staged')), /kept app is version 0.0.3, not 0.0.2/);
    const back = await stageKeptMacApp(keep, '0.0.3', path.join(updates, '0.0.3', 'staged'));
    assert.equal(version(back), '0.0.3');
    assert.equal(version(keep), '0.0.3', 'the kept one stays for another time');
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('Update tests passed.');
