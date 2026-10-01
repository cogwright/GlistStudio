import assert from 'node:assert/strict';
import { crashOf } from '../src/debug-crash.ts';

// Crashes in kinds the window words, from the debugger's stop and the program's last output. Run with jiti.

// Breakpoints, steps and pauses are not crashes.
assert.equal(crashOf('breakpoint', 'breakpoint 1.1'), null);
assert.equal(crashOf('step'), null);
assert.equal(crashOf('pause'), null);
// lldb-dap and GDB words for a bad memory access.
assert.deepEqual(crashOf('exception', 'EXC_BAD_ACCESS (code=1, address=0x18)'), { kind: 'memory', detail: 'EXC_BAD_ACCESS (code=1, address=0x18)' });
assert.equal(crashOf('signal', 'Signal SIGSEGV', '')?.kind, 'memory');
assert.equal(crashOf('exception', 'EXC_ARITHMETIC (code=EXC_I386_DIV)')?.kind, 'arithmetic');
assert.equal(crashOf('exception', 'EXC_BREAKPOINT (code=1, subcode=0x100003f90)')?.kind, 'instruction');
// An abort after an exception nothing caught, as libc++ and libstdc++ print it.
assert.deepEqual(crashOf('exception', 'signal SIGABRT', '', 'libc++abi: terminating due to uncaught exception of type std::runtime_error: Level file missing\n'),
  { kind: 'exception', detail: 'std::runtime_error: Level file missing' });
assert.deepEqual(crashOf('signal', 'SIGABRT', '', "terminate called after throwing an instance of 'std::out_of_range'\n  what():  vector::_M_range_check\n"),
  { kind: 'exception', detail: 'std::out_of_range: vector::_M_range_check' });
// After an assert, as macOS and glibc print it.
assert.deepEqual(crashOf('exception', 'signal SIGABRT', '', 'Assertion failed: (how.empty() && "the level has a name"), function crash, file main.cpp, line 22.\n'),
  { kind: 'assert', detail: 'how.empty() && "the level has a name"' });
assert.deepEqual(crashOf('signal', 'SIGABRT', '', "App: main.cpp:22: void crash(): Assertion `x > 0' failed.\n"), { kind: 'assert', detail: 'x > 0' });
// lldb-dap's own words for an assert, with what the program printed.
assert.deepEqual(crashOf('exception', 'hit program assert', '', 'Assertion failed: (x > 0), function crash, file main.cpp, line 22.\n'), { kind: 'assert', detail: 'x > 0' });
// A plain abort, and an exception stop the debugger gives no more about.
assert.deepEqual(crashOf('exception', 'signal SIGABRT', '', 'nothing said\n'), { kind: 'abort', detail: 'signal SIGABRT' });
assert.deepEqual(crashOf('exception', 'something else'), { kind: 'signal', detail: 'something else' });

console.log('Debug crash tests passed.');
