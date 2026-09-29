import assert from 'node:assert/strict';
import { splitArguments } from '../src/run-arguments.ts';

// Program arguments, written as on a command line. Run with jiti.
assert.deepEqual(splitArguments(''), []);
assert.deepEqual(splitArguments('  --level 2  '), ['--level', '2']);
assert.deepEqual(splitArguments('"my file.txt" \'it is\' plain'), ['my file.txt', 'it is', 'plain']);
assert.deepEqual(splitArguments('--name="Glist Studio" end'), ['--name=Glist Studio', 'end']);
assert.deepEqual(splitArguments('C:\\data\\level.txt "C:\\my data\\x"'), ['C:\\data\\level.txt', 'C:\\my data\\x'], 'Windows paths as written');
assert.deepEqual(splitArguments('say \\"hi\\" "a \\"quoted\\" word"'), ['say', '"hi"', 'a "quoted" word']);
assert.deepEqual(splitArguments('"" x'), ['', 'x'], 'an empty argument in quotes is kept');
assert.deepEqual(splitArguments('"unclosed quote'), ['unclosed quote']);
console.log('Argument tests passed.');
