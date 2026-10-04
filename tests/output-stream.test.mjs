import assert from 'node:assert/strict';
import { outputStream } from '../src/output-stream.ts';

// What builds and programs print goes to the window in batches: one message an
// interval however many pieces came, stdout and stderr in order, characters
// split between pieces whole, the newest lines past a limit with a note of how
// many were left out, and the rest at once when flushed. Run with jiti.

const wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });
const collect = (options) => {
  const sent = [];
  const stream = outputStream((text) => sent.push(text), { interval: 20, ...options });
  return { sent, stream };
};

// Many pieces, one message.
{
  const { sent, stream } = collect();
  const out = stream.reader();
  for (let index = 0; index < 500; index += 1) out(Buffer.from(`line ${index}\n`));
  assert.equal(sent.length, 0, 'nothing is sent at once');
  await wait(40);
  assert.equal(sent.length, 1, 'one message for what came in an interval');
  assert.equal(sent[0].split('\n').length, 501);
  assert.ok(sent[0].startsWith('line 0\n') && sent[0].endsWith('line 499\n'));
}

// stdout and stderr in the order they came, stderr dressed.
{
  const { sent, stream } = collect();
  const out = stream.reader();
  const err = stream.reader((text) => `<${text}>`);
  out(Buffer.from('a\n'));
  err(Buffer.from('b\n'));
  out(Buffer.from('c\n'));
  stream.flush();
  assert.deepEqual(sent, ['a\n<b\n>c\n']);
}

// A character split between two pieces arrives whole; flushing sends at once, and only once.
{
  const { sent, stream } = collect();
  const out = stream.reader();
  const bytes = Buffer.from('ğüş é\n');
  out(bytes.subarray(0, 1));
  out(bytes.subarray(1, 6));
  out(bytes.subarray(6));
  stream.flush();
  assert.deepEqual(sent, ['ğüş é\n']);
  await wait(40);
  assert.equal(sent.length, 1, 'the interval\'s timer does not send it again');
  stream.flush();
  assert.equal(sent.length, 1, 'an empty flush sends nothing');
}

// Past the limit: the newest whole lines, after a note counting the rest.
{
  const { sent, stream } = collect({ limit: 100, skipped: (count) => `[${count} skipped]` });
  const out = stream.reader();
  for (let index = 0; index < 1000; index += 1) out(Buffer.from(`${String(index).padStart(4, '0')}\n`));
  await wait(40);
  assert.equal(sent.length, 1);
  const [note, ...lines] = sent[0].split('\n');
  assert.equal(lines.pop(), '', 'ends with its last line');
  assert.equal(lines.at(-1), '0999', 'the newest line is kept');
  assert.ok(lines.every((line) => /^\d{4}$/.test(line)), 'whole lines only');
  assert.ok(lines.length * 5 <= 100, 'within the limit');
  assert.equal(note, `[${1000 - lines.length} skipped]`, 'every line left out is counted');
  // The next batch, within the limit, has no note.
  out(Buffer.from('after\n'));
  await wait(40);
  assert.equal(sent[1], 'after\n');
}

// A batch ends where a line does, the rest of the line going with the next; a
// prompt with no line end shows after an interval; a note never joins a line.
{
  const { sent, stream } = collect({ limit: 50, skipped: (count) => `[${count} skipped]` });
  const out = stream.reader();
  out(Buffer.from('one\ntw'));
  await wait(30);
  assert.deepEqual(sent, ['one\n'], 'the line cut short waits');
  out(Buffer.from('o\n'));
  await wait(30);
  assert.deepEqual(sent, ['one\n', 'two\n'], 'and goes whole with the next batch');
  out(Buffer.from('Name? '));
  await wait(70);
  assert.equal(sent.at(-1), 'Name? ', 'a prompt shows without a line end, an interval later');
  out(Buffer.from(`${'x'.repeat(30)}\n${'y'.repeat(30)}\nlast\n`));
  await wait(30);
  assert.equal(sent.at(-1), `\n[1 skipped]\n${'y'.repeat(30)}\nlast\n`, 'after a line left unended, the note starts a line of its own');
}

// Without a limit, a build's output all arrives, however much.
{
  const { sent, stream } = collect();
  const out = stream.reader();
  const big = 'x'.repeat(99) + '\n';
  for (let index = 0; index < 20000; index += 1) out(Buffer.from(big));
  stream.flush();
  assert.equal(sent.join('').length, 2_000_000);
}

console.log('Output stream tests passed.');
