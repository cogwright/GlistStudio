// What a crash was, in kinds the window puts in words, from why the debugger
// stopped and what the program printed last. No Monaco or DOM, so it can be
// tested on its own.

export type CrashKind = 'memory' | 'exception' | 'assert' | 'abort' | 'arithmetic' | 'instruction' | 'signal';

export interface Crash {
  kind: CrashKind;
  // As the debugger or the program said it: EXC_BAD_ACCESS (code=1, address=0x18),
  // std::runtime_error: Level file missing, or the assert's condition.
  detail: string;
}

// Stops that are not crashes: the user's breakpoints, steps and pauses.
const ordinary = new Set(['breakpoint', 'step', 'pause', 'entry', 'goto', 'function breakpoint', 'data breakpoint', 'instruction breakpoint']);

const signals: Array<[RegExp, CrashKind]> = [
  [/EXC_BAD_ACCESS|SIGSEGV|SIGBUS|segmentation fault|access violation/i, 'memory'],
  [/EXC_ARITHMETIC|SIGFPE|divide by zero|division by zero/i, 'arithmetic'],
  [/EXC_BAD_INSTRUCTION|EXC_BREAKPOINT|SIGILL|SIGTRAP|illegal instruction/i, 'instruction'],
  [/SIGABRT|abort/i, 'abort'],
];

// What the program printed on its way down: an exception nothing caught, as
// libc++ or libstdc++ word it, or an assert that failed.
const printed = (output: string): Crash | null => {
  // The type ends at ": ", which a name's :: never has.
  const libcxx = /terminating (?:due to|with) uncaught exception of type ([^\n]+?)(?:: ([^\n]*))?\s*$/m.exec(output);
  if (libcxx) return { kind: 'exception', detail: libcxx[2] ? `${libcxx[1].trim()}: ${libcxx[2].trim()}` : libcxx[1].trim() };
  const libstdcxx = /terminate called after throwing an instance of '([^']+)'(?:\s*\n\s*what\(\):\s*([^\n]*))?/.exec(output);
  if (libstdcxx) return { kind: 'exception', detail: libstdcxx[2] ? `${libstdcxx[1]}: ${libstdcxx[2].trim()}` : libstdcxx[1] };
  const assertion = /Assertion failed: \(?(.+?)\)?, function|Assertion failed: (.+?), file|Assertion `(.+?)' failed/.exec(output);
  if (assertion) return { kind: 'assert', detail: (assertion[1] ?? assertion[2] ?? assertion[3]).trim() };
  return null;
};

// The crash a stop was, or null for a breakpoint, a step or a pause.
export const crashOf = (reason: string, description = '', text = '', output = ''): Crash | null => {
  if (ordinary.has(reason)) return null;
  const said = `${description} ${text}`.trim();
  const kind = signals.find(([pattern]) => pattern.test(said))?.[1];
  // An abort is most often an exception nothing caught or an assert, which the program said.
  if (kind === 'abort' || (!kind && reason === 'exception')) {
    const why = printed(output);
    if (why) return why;
  }
  if (kind) return { kind, detail: said };
  if (reason === 'exception' || reason === 'signal') return { kind: 'signal', detail: said };
  return null;
};
