import assert from 'node:assert/strict';
import { shownValue } from '../src/debug-values.ts';

// Values in the Variables view and the value popup. Run with jiti.

// Pointers as addresses, nullptr when null, objects known only by address as their type.
assert.equal(shownValue('0x000000016fdfe758', 'Player *', true), '0x16fdfe758');
assert.equal(shownValue('0x0000000000000000', 'Player *'), 'nullptr');
assert.equal(shownValue('0x0', 'int *'), 'nullptr');
assert.equal(shownValue('0x0000000100003f90 "Ada"', 'const char *'), '0x100003f90 "Ada"');
assert.equal(shownValue('0x0000000000000000', 'std::nullptr_t'), 'nullptr');
assert.equal(shownValue('Player @ 0x16fdfe758', 'Player', true), '{Player}');
assert.equal(shownValue('35', 'int'), '35');
assert.equal(shownValue('size=3', 'std::vector<int>', true), 'size=3');
// A number that is not a pointer stays as it is.
assert.equal(shownValue('0x10', 'int'), '0x10');

console.log('Debug value tests passed.');
