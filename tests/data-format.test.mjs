import assert from 'node:assert/strict';
import {
  DataFormatError, formatIni, formatToml, formatYaml, isDataLanguage, tomlProblems, yamlProblems,
} from '../src/data-format.ts';

assert.ok(isDataLanguage('toml') && isDataLanguage('json') && !isDataLanguage('cpp'));

// YAML: indented again, its comments, quotes, anchors and documents kept.
assert.equal(formatYaml([
  '# game settings',
  'window:',
  '    width: 1280   # pixels',
  '    title: "My Game"',
  'levels:',
  '- &first one',
  '- *first',
  '---',
  'second: true',
  '',
].join('\n')), [
  '# game settings',
  'window:',
  '  width: 1280 # pixels',
  '  title: "My Game"',
  'levels:',
  '  - &first one',
  '  - *first',
  '---',
  'second: true',
  '',
].join('\n'));
assert.equal(formatYaml('a:\n    b: 1\n', 4), 'a:\n    b: 1\n');
assert.equal(formatYaml(''), '');
assert.equal(formatYaml('a: 1\r\nb:\r\n    - 2\r\n'), 'a: 1\r\nb:\r\n  - 2\r\n');
assert.throws(() => formatYaml('a: [1, 2\nb: 3\n'), (error) => error instanceof DataFormatError && error.problem.line >= 1);
assert.deepEqual(yamlProblems('ok: 1\n'), []);
assert.deepEqual(yamlProblems('a: 1\na: 2\n').map(({ line, column, message }) => [line, column, message]), [[2, 1, 'Map keys must be unique']]);

// TOML: key = value spaced so, one blank line before a table (above the comments
// that say what it is), indentation gone, multi-line strings and arrays as written.
assert.equal(await formatToml([
  'title="Game"   ',
  '  version =  2',
  '',
  '',
  '# the window',
  '[window]',
  'size=[ 1280,',
  '   720 ]',
  'motd = """',
  '   keep   this  ',
  'as is"""',
  '[[levels]]',
  'name = "a=b" # an = in a string',
].join('\n')), [
  'title = "Game"',
  'version = 2',
  '',
  '# the window',
  '[window]',
  'size = [ 1280,',
  '   720 ]',
  'motd = """',
  '   keep   this  ',
  'as is"""',
  '',
  '[[levels]]',
  'name = "a=b" # an = in a string',
  '',
].join('\n'));
await assert.rejects(formatToml('a = \n'), (error) => error instanceof DataFormatError && error.problem.line === 1);
const [tomlMistake] = await tomlProblems('a = 1\nb = [1,\n');
assert.ok(tomlMistake && tomlMistake.line >= 2, JSON.stringify(tomlMistake));
assert.deepEqual((await tomlProblems('a = 1\na = 2\n')).map(({ line, message }) => [line, message]), [[2, 'Trying to redefine an already defined table or value']]);
assert.deepEqual(await tomlProblems('a = 1\n'), []);

// INI: the same, but indentation kept (a continued value), and ; comments.
assert.equal(formatIni([
  '; settings',
  '[user]',
  '\tname=Ada',
  '\temail =ada@example.com',
  '[core]',
  'editor  = vim',
  'long = first',
  '   second line',
  'url = http://x?a=b',
].join('\r\n')), [
  '; settings',
  '[user]',
  '\tname = Ada',
  '\temail = ada@example.com',
  '',
  '[core]',
  'editor = vim',
  'long = first',
  '   second line',
  'url = http://x?a=b',
  '',
].join('\r\n'));

console.log('Data format tests passed.');
