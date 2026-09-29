import assert from 'node:assert/strict';
import { plainText, searchCommands } from '../src/command-search.ts';

// Finding commands in the palette. Run with jiti.
const commands = [
  { label: 'Derle', category: 'Çalıştır' },
  { label: 'Çalıştır', category: 'Çalıştır' },
  { label: 'Hata Ayıkla', category: 'Çalıştır' },
  { label: 'Durdur', category: 'Çalıştır', disabled: true },
  { label: 'Terminali Göster', category: 'Görünüm' },
  { label: 'Sembolü Yeniden Adlandır', category: 'Düzenleyici' },
  { label: 'İleri Git', category: 'Düzenleyici' },
];
const labels = (query) => searchCommands(commands, query).map((command) => command.label);

// Accents and the dotless i do not matter, nor does case.
assert.equal(plainText('Çalıştır İleri'), 'calistir ileri');
assert.deepEqual(labels('calistir').slice(0, 1), ['Çalıştır']);
assert.deepEqual(labels('ILERI'), ['İleri Git']);
// Every word must appear, in any order, in the name or where it comes from.
assert.deepEqual(labels('adlandir yeniden'), ['Sembolü Yeniden Adlandır']);
assert.deepEqual(labels('gorunum'), ['Terminali Göster']);
assert.deepEqual(labels('nothing here'), []);
// Names that start with it first, then a word that does, then the rest.
assert.deepEqual(labels('a'), ['Hata Ayıkla', 'Sembolü Yeniden Adlandır', 'Derle', 'Çalıştır', 'Terminali Göster', 'Durdur']);
assert.deepEqual(labels('ter'), ['Terminali Göster']);
// With nothing typed, all of them, those that cannot run now last.
assert.deepEqual(labels('  ').slice(-1), ['Durdur']);
assert.equal(labels('').length, commands.length);

console.log('Command search tests passed.');
