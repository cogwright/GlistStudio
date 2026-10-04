import { StringDecoder } from 'node:string_decoder';

// What a build or a running program prints, sent to the window in batches
// rather than as each piece arrives: a game that logs every frame printed
// thousands of pieces a second, each a message of its own, and the backend
// stopped answering for seconds while it sent them (a ping took 11 s). What
// gathers in one interval goes as one message, stdout and stderr in the order
// they came. A batch ends at the end of a line, the rest waiting for the next,
// unless there is no line end to stop at, as for a prompt. With a limit, a
// program printing more in an interval than anyone could read has its newest
// lines sent, after a note of how many were left out; a build has none, as a
// compiler's first error matters most. Bytes are read as UTF-8 across pieces,
// so a character split between two is not garbled.
export interface OutputStream {
  // A reader for one of the program's streams, its text dressed as given (stderr's red).
  reader(dress?: (text: string) => string): (chunk: Buffer) => void;
  // Sends what is gathered now: before the program's end is told, or anything else printed.
  flush(): void;
}

export interface OutputStreamOptions {
  interval?: number;
  // The most characters one batch carries.
  limit?: number;
  // The note for lines left out.
  skipped?: (count: number) => string;
}

const lineCount = (text: string): number => {
  let count = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1;
  return count;
};

export const outputStream = (send: (text: string) => void, options: OutputStreamOptions = {}): OutputStream => {
  const interval = options.interval ?? 50;
  const limit = options.limit ?? Infinity;
  const decoders: StringDecoder[] = [];
  let pending = '';
  let skipped = 0;
  // Whether what was sent last ended its line, so a note starts on a line of its own.
  let ended = true;
  let timer: NodeJS.Timeout | null = null;
  // The newest lines within the limit, from the start of a line where there is one.
  const trim = (): void => {
    if (pending.length <= limit) return;
    const cut = pending.length - limit;
    const lineStart = pending.indexOf('\n', cut);
    const from = lineStart >= 0 && lineStart < pending.length - 1 ? lineStart + 1 : cut;
    skipped += Math.max(1, lineCount(pending.slice(0, from)));
    pending = pending.slice(from);
  };
  const flush = (whole: boolean): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    trim();
    if (!pending) return;
    const lineEnd = whole ? pending.length - 1 : pending.lastIndexOf('\n');
    const upTo = lineEnd >= 0 ? lineEnd + 1 : pending.length;
    const note = skipped && options.skipped ? `${ended ? '' : '\n'}${options.skipped(skipped)}\n` : '';
    const text = pending.slice(0, upTo);
    pending = pending.slice(upTo);
    skipped = 0;
    ended = text.endsWith('\n');
    send(note + text);
    if (pending) timer = setTimeout(() => flush(false), interval);
  };
  return {
    reader: (dress) => {
      const decoder = new StringDecoder('utf8');
      decoders.push(decoder);
      return (chunk) => {
        const text = decoder.write(chunk);
        if (!text) return;
        pending += dress ? dress(text) : text;
        // Twice the limit at most while it gathers, so a flood does not pile up between batches.
        if (pending.length > limit * 2) trim();
        // A program printing without a pause still shows, a batch an interval.
        if (!timer) timer = setTimeout(() => flush(false), interval);
      };
    },
    flush: () => {
      for (const decoder of decoders) {
        const rest = decoder.end();
        if (rest) pending += rest;
      }
      flush(true);
    },
  };
};
