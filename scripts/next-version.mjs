// The version a build of main gets (.github/workflows/release.yml): the next
// release after the last one, and main's commits since it, such as
// 26.2.0-dev.17, which the studio shows as "26.2 Preview 17". Releases are
// numbered by year: the N-th of 2026 is 26.N.0, and a new year's first is
// YY.1.0, so the number always goes up, from the 0.0.x before them too.
//   node scripts/next-version.mjs <last release tag, or nothing> <commits since it>

// A release tag, v26.1 or v26.1.0, as major, minor and patch; null if it is none.
export const releaseOf = (tag) => {
  const found = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(tag ?? '').trim());
  return found ? { major: Number(found[1]), minor: Number(found[2]), patch: Number(found[3] ?? 0) } : null;
};

export const nextVersion = (lastTag, count, year = new Date().getUTCFullYear()) => {
  const last = releaseOf(lastTag);
  const yy = year % 100;
  const minor = last && last.major === yy ? last.minor + 1 : 1;
  return `${yy}.${minor}.0-dev.${Number(count) || 0}`;
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  console.log(nextVersion(process.argv[2] || null, process.argv[3] ?? 0));
}
