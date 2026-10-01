// The language for git, compilers and make. No Electron, so it can be tested on its own.

// What makes command-line tools answer in the editor's language where they
// have it: git (Homebrew's, Git for Windows and Linux distributions'; Apple's
// is English only), and GCC and make in builds on Windows and Linux. Clang,
// clangd and CMake have no translations. Glist Studio reads none of their
// sentences, only formats that stay the same in every language, so they can be
// in any. A system without a locale gets one: gettext ignores LANGUAGE under
// the C locale, and turns letters its character set lacks into others (ü into
// "u), so it writes UTF-8. One every system has: Linux often lacks en_US.UTF-8
// but has C.UTF-8, which macOS's gettext takes for plain C; Windows' only reads
// the name.
const fallbackLocale = (platform: NodeJS.Platform): string => (platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8');

export const toolLanguage = (language: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv => {
  const messages = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  const characters = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return {
    LANGUAGE: language,
    ...(!messages || /^(C|POSIX)([._@]|$)/i.test(messages) ? { LC_MESSAGES: fallbackLocale(platform) } : {}),
    ...(env.LC_ALL || /utf-?8/i.test(characters) ? {} : { LC_CTYPE: fallbackLocale(platform) }),
  };
};
