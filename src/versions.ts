// A version as people read it: a release, 26.2.0, as 26.2 (a fix, 26.2.1, as
// it is), and a build of main, 26.2.0-dev.17, as "26.2 Preview 17", the
// preview of the release to come, numbered by main's commits since the last
// (scripts/next-version.mjs). Anything else is left as it is. The words for
// a preview are the caller's, in the window's language.
export const versionName = (version: string, preview: string): string => {
  const found = /^v?(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(version.trim());
  if (!found) return version;
  const [, major, minor, patch, build] = found;
  const release = patch === '0' ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
  return build === undefined ? release : preview.replace('{version}', release).replace('{number}', build);
};
