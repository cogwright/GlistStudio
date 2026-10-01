import { getHostPlatform } from './host';
import { isLanguage, languages, type Language, type Words } from './languages';
import { shortcutLabel } from './shortcuts';

// The words themselves are in locales/, one JSON file per language (languages.ts).
export type { Language };
export type TranslationKey = keyof Words['interface'];

// Names the host gives its trash, file manager and terminal, where they differ
// from the Windows ones the interface words use.
const hostWords = (words: Words): Partial<Record<TranslationKey, string>> | undefined =>
  (words.platforms as Record<string, Partial<Record<TranslationKey, string>>>)[getHostPlatform()];

export const savedLanguage = (): Language => {
  try {
    const saved = window.localStorage.getItem('glist-studio-language');
    return isLanguage(saved) ? saved : 'en';
  } catch { return 'en'; }
};

let language: Language = savedLanguage();

export const getLanguage = (): Language => language;
// A whole percentage as the language writes it: 100%, %100, 100 %.
export const percent = (value: number): string =>
  new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 0 }).format(value / 100);
export const t = (key: TranslationKey): string =>
  hostWords(languages[language])?.[key] ?? languages[language].interface[key];

// Puts the words of the language in use into marked elements under root, the
// root too: views kept off the page, such as the Git tab's, when shown again.
export const translate = (root: ParentNode): void => {
  const all = <T extends Element>(selector: string): T[] => [
    ...(root instanceof Element && root.matches(selector) ? [root as T] : []), ...root.querySelectorAll<T>(selector),
  ];
  all<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n as TranslationKey;
    if (key in languages.en.interface) node.textContent = t(key);
  });
  all<HTMLElement>('[data-i18n-title]').forEach((node) => {
    const key = node.dataset.i18nTitle as TranslationKey;
    if (key in languages.en.interface) node.title = shortcutLabel(t(key));
  });
  all<HTMLInputElement>('[data-i18n-placeholder]').forEach((node) => {
    const key = node.dataset.i18nPlaceholder as TranslationKey;
    if (key in languages.en.interface) node.placeholder = t(key);
  });
  all<HTMLElement>('[data-i18n-aria-label]').forEach((node) => {
    const key = node.dataset.i18nAriaLabel as TranslationKey;
    if (key in languages.en.interface) node.setAttribute('aria-label', t(key));
  });
};

export const applyLanguage = (next: Language): void => {
  language = next;
  try { window.localStorage.setItem('glist-studio-language', next); } catch { /* Storage may be unavailable. */ }
  document.documentElement.lang = next;
  translate(document);
  document.querySelectorAll('kbd').forEach((node) => { node.textContent = shortcutLabel(node.textContent ?? ''); });
};
