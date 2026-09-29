import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assetFor, download, installMacApp, isNewer, latestTag, releaseAt, replaceAppImage, stageMacApp,
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
  } else if (request.url.startsWith('/owner/repo/releases')) {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(request.method === 'HEAD' ? undefined : '<html></html>');
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
  latest = '';
  assert.equal(await latestTag(source), null, 'no published release yet');
  latest = 'v0.0.3';

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
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('Update tests passed.');
