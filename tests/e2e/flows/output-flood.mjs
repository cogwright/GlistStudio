// A program that prints a lot (a game logging every frame, then a loop printing as fast as it
// can) leaves the studio answering: the backend's ping stays quick and the window keeps drawing,
// where each piece used to be a message of its own and the backend went silent for seconds. Every
// line shown is whole and in order, any lines left out are counted in a note where they were, the
// last line arrives, and the run keeps only its newest output, saying so at its top. Built and run
// for real, so skipped without CMake and a C++ compiler.
import { e2e, which, writeFiles } from '../common.mjs';
import path from 'node:path';

await e2e({
  setup: (w, t) => {
    if (!which('cmake') || !(which('c++') || which('g++') || which('clang++'))) t.skip('CMake or a C++ compiler is not installed');
    writeFiles(path.join(w.projects, 'FloodApp'), {
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(FloodApp CXX)\nadd_executable(FloodApp src/main.cpp)\n',
      'src/main.cpp': [
        '#include <chrono>', '#include <cstdio>', '#include <thread>',
        'int main() {', '  long n = 0;',
        '  // A game\'s log: 40 lines a frame, 2 ms apart.',
        '  for (int frame = 0; frame < 750; ++frame) {',
        '    for (int line = 0; line < 40; ++line) std::printf("line %ld: frame %d, player at (%d, %d)\\n", n++, frame, frame % 640, line * 7);',
        '    std::fflush(stdout);', '    std::this_thread::sleep_for(std::chrono::milliseconds(2));', '  }',
        '  // Then as fast as it can.',
        '  auto start = std::chrono::steady_clock::now();',
        '  while (std::chrono::steady_clock::now() - start < std::chrono::seconds(3)) std::printf("line %ld: as fast as it can\\n", n++);',
        '  std::printf("done after %ld lines\\n", n);', '  return 0;', '}', '',
      ].join('\n'),
    });
  },
}, async (t) => {
  const { page } = t;
  await t.openProject('FloodApp');
  await page.click('#run-project');
  const text = () => page.evaluate(() => [...document.querySelectorAll('#output .output-run')].at(-1)?.textContent ?? '');
  t.check('it builds and starts printing', await t.settle(text, (value) => /line \d+:/.test(value), 120000).then((value) => /line \d+:/.test(value)));

  // While it prints: the backend's ping every 200 ms, and the window's longest frame.
  const { pings, gap } = await page.evaluate(async () => {
    let longest = 0;
    let last = performance.now();
    let stop = false;
    const tick = () => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const times = [];
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const start = performance.now();
      await window.glistAPI.ping();
      times.push(Math.round(performance.now() - start));
      await new Promise((resolve) => { setTimeout(resolve, 200); });
    }
    stop = true;
    return { pings: times, gap: Math.round(longest) };
  });
  t.check('the backend keeps answering while it prints', Math.max(...pings) < 1500 && pings.length >= 10, pings);
  t.check('and the window keeps drawing', gap < 1000, `${gap} ms`);

  const done = await t.settle(text, (value) => /done after \d+ lines/.test(value), 20000);
  t.check('its last line arrives', /done after \d+ lines/.test(done), done.slice(-300));

  // Each line whole, the numbers rising by one, and where they jump, a note counting the lines left out.
  const problems = [];
  let previous = null;
  let skipped = 0;
  let notes = 0;
  let shown = 0;
  for (const line of done.split('\n')) {
    const note = /^([\d,.\s]+) lines left out/.exec(line);
    if (note) { skipped += Number(note[1].replace(/\D/g, '')); notes += 1; continue; }
    if (!line.startsWith('line ')) continue;
    const match = /^line (\d+): (frame \d+, player at \(\d+, \d+\)|as fast as it can)$/.exec(line);
    if (!match) { problems.push(`not whole: ${line}`); continue; }
    const number = Number(match[1]);
    if (previous !== null && number !== previous + 1 + skipped) problems.push(`after ${previous}, ${number}, with ${skipped} counted as left out`);
    previous = number;
    skipped = 0;
    shown += 1;
  }
  t.check('every line shown whole and in order, any left out counted where they were', problems.length === 0 && shown > 1000, { shown, notes, problems: problems.slice(0, 5) });
  const kept = await page.evaluate(() => {
    const run = [...document.querySelectorAll('#output .output-run')].at(-1);
    return { characters: run.textContent.length, trimmed: run.querySelector('.output-trimmed')?.textContent ?? null };
  });
  t.check('the run keeps its newest output only, and says so at its top', kept.characters <= 1_100_000 && /Earlier output is not shown/.test(kept.trimmed ?? ''), kept);
});
