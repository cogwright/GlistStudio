import en from './locales/en.json';
import fr from './locales/fr.json';
import tr from './locales/tr.json';

// Every word the studio shows, one file per language in locales/: the
// interface's, the ones that differ by system, and the backend's messages.
// A language is added by translating en.json and naming it here. No DOM, so
// the backend uses it too.

export type Words = typeof en;

export type Language = 'en' | 'tr' | 'fr';

// Each has every word English has; the type check names any missing.
export const languages: Record<Language, Words> = { en, tr, fr };

export const isLanguage = (value: unknown): value is Language =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(languages, value);
