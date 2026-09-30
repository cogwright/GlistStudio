import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// Every language in src/locales has the words English has, no others, and
// keeps what the code fills in or reads: {placeholders} and shortcuts.

const folder = new URL('../src/locales/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, folder), 'utf8'));
const en = read('en.json');
const files = readdirSync(folder).filter((file) => file.endsWith('.json'));
const registry = readFileSync(new URL('../src/languages.ts', import.meta.url), 'utf8');

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
// Ctrl+S, Ctrl+Shift+B, Ctrl++, F5, Shift+F11, Ctrl+Enter: shortcutLabel turns Ctrl into Cmd on a Mac.
const shortcuts = (text) => [...text.matchAll(/\b(?:Ctrl|Shift|Alt)\+(?:[\w+-]+)|\bF\d+\b/g)].map((match) => match[0]).sort();

// The words of one section, compared with English's.
const compare = (language, section, words, english) => {
  assert.deepEqual(Object.keys(words).sort(), Object.keys(english).sort(), `${language} ${section}: not the same words as English`);
  for (const [key, text] of Object.entries(words)) {
    const where = `${language} ${section}.${key}`;
    assert.equal(typeof text, 'string', `${where}: not text`);
    assert.ok(text.trim(), `${where}: empty`);
    assert.deepEqual(placeholders(text), placeholders(english[key]), `${where}: placeholders differ from English`);
    assert.deepEqual(shortcuts(text), shortcuts(english[key]), `${where}: shortcuts differ from English`);
  }
};

const names = new Set();
for (const file of files) {
  const language = file.replace(/\.json$/, '');
  const words = read(file);
  assert.ok(registry.includes(`from './locales/${file}'`), `${file} is not named in languages.ts`);
  assert.deepEqual(Object.keys(words).sort(), Object.keys(en).sort(), `${language}: not the same sections as English`);
  assert.ok(words.name.trim() && !names.has(words.name), `${language}: needs a name of its own`);
  names.add(words.name);
  for (const [section, english] of Object.entries(en)) {
    if (section === 'name') continue;
    if (section === 'platforms') {
      assert.deepEqual(Object.keys(words.platforms).sort(), Object.keys(english).sort(), `${language}: not the same systems as English`);
      for (const [system, systemWords] of Object.entries(english)) {
        compare(language, `platforms.${system}`, words.platforms[system], systemWords);
        // A system's word stands in for an interface word.
        for (const key of Object.keys(systemWords)) assert.ok(key in en.interface, `platforms.${system}.${key} is not an interface word`);
      }
      continue;
    }
    compare(language, section, words[section], english);
  }
}
assert.ok(files.length >= 3, 'English, Turkish and French at least');
console.log(`locales: ${files.length} languages, ${Object.keys(en.interface).length} interface words each`);
