// Open files read again from disk (as on coming back to the window, or after git changed them)
// while their tabs are being closed: a tab closed during the read of the one before it is left
// alone, not touched with its model gone ("Model is disposed!", seen on CI in the tabs flow when
// a file was deleted while the others were read again).
import { e2e, glistApp } from '../common.mjs';

await e2e({
  setup: (w) => {
    glistApp(w, 'ReloadApp', { 'src/a.cpp': 'int a;\n', 'src/b.cpp': 'int b;\n', 'src/c.cpp': 'int c;\n' });
  },
}, async (t) => {
  const { page } = t;
  const app = t.project('ReloadApp');
  await t.openProject('ReloadApp');
  for (const name of ['a', 'b', 'c']) await t.openFile(`${app}/src/${name}.cpp`);
  const tabs = () => page.locator('#editor-tabs .editor-tab').count();
  await t.eventually('three tabs open', tabs, (count) => count === 3);
  // Each file comes from the backend a moment later, as on a slow machine.
  await page.evaluate(() => {
    const read = window.glistAPI.readFile;
    window.glistAPI.readFile = async (...args) => { const text = await read(...args); await new Promise((resolve) => { setTimeout(resolve, 400); }); return text; };
  });
  // Coming back to the window reads the open files again; the last two close meanwhile.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(100);
  for (const name of ['c.cpp', 'b.cpp']) await page.locator('#editor-tabs .editor-tab', { hasText: name }).locator('.tab-close').click();
  await page.waitForTimeout(1600);
  await t.eventually('the closed tabs stay closed, the first still open', tabs, (count) => count === 1);
});
