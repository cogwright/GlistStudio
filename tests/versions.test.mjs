import assert from 'node:assert/strict';
import { nextVersion, releaseOf } from '../scripts/next-version.mjs';
import { versionName } from '../src/versions.ts';

// What a build of main is numbered: the release to come by year, and main's commits since the last.
assert.equal(nextVersion('v0.0.9', 123, 2026), '26.1.0-dev.123', 'from the 0.0.x before, the year\'s first');
assert.equal(nextVersion('v26.1', 5, 2026), '26.2.0-dev.5');
assert.equal(nextVersion('v26.1.0', 5, 2026), '26.2.0-dev.5');
assert.equal(nextVersion('v26.3.1', 0, 2026), '26.4.0-dev.0', 'after a fix, the next release');
assert.equal(nextVersion('v26.9', 40, 2027), '27.1.0-dev.40', 'a new year starts again at 1');
assert.equal(nextVersion(null, 7, 2026), '26.1.0-dev.7', 'no release yet');
assert.equal(nextVersion('', '12', 2026), '26.1.0-dev.12');
assert.deepEqual(releaseOf('v26.2'), { major: 26, minor: 2, patch: 0 });
assert.equal(releaseOf('v26.2.0-dev.3'), null, 'a preview is no release');
// Always newer than the one before, across a new year and from the old numbers.
const order = ['0.0.10-dev.40', nextVersion('v0.0.9', 41, 2026), nextVersion('v26.1', 1, 2026), nextVersion('v26.4', 2, 2027)];
assert.deepEqual(order, ['0.0.10-dev.40', '26.1.0-dev.41', '26.2.0-dev.1', '27.1.0-dev.2']);

// As people read them.
const preview = '{version} Preview {number}';
assert.equal(versionName('26.2.0-dev.17', preview), '26.2 Preview 17');
assert.equal(versionName('26.2.0', preview), '26.2');
assert.equal(versionName('v26.2.0', preview), '26.2');
assert.equal(versionName('26.2.1', preview), '26.2.1');
assert.equal(versionName('26.2.1-dev.3', preview), '26.2.1 Preview 3');
assert.equal(versionName('26.10.0', preview), '26.10');
assert.equal(versionName('0.0.10-dev.40', preview), '0.0.10 Preview 40');
assert.equal(versionName('26.2.0-dev.17', '{version} Önizleme {number}'), '26.2 Önizleme 17');
assert.equal(versionName('44.5.1-beta.2', preview), '44.5.1-beta.2', 'anything else as it is');
assert.equal(versionName('', preview), '');

console.log('Version tests passed.');
