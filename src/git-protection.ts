// Protected branches, as JetBrains IDEs have them: the ones named in Settings,
// and the ones the repository's host protects. With protection on, those are
// never force pushed, and a commit already pushed is never amended, so nobody
// rewrites history others may already have.

export const defaultProtection: GlistGitProtection = { on: true, branches: ['main', 'master'] };

// What the renderer sent, kept to what it can mean.
export const protectionFrom = (value: unknown): GlistGitProtection => {
  const given = value as Partial<GlistGitProtection> | null;
  if (!given || typeof given !== 'object') return defaultProtection;
  const branches = Array.isArray(given.branches)
    ? given.branches.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
    : defaultProtection.branches;
  return { on: given.on !== false, branches };
};

// A branch against names such as "main" and patterns such as "release/*".
export const matchesBranch = (branch: string, patterns: string[]): boolean => patterns.some((pattern) =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(branch));

// owner/repository for a GitHub address in any form git takes, or null.
export const githubRepository = (url: string): string | null => {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i
    .exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
};

const tenMinutes = 10 * 60 * 1000;

// The branches GitHub protects in a repository, asked at most once in ten
// minutes and without signing in, so only public repositories answer; any
// other answer counts as none. A change calls back, for the views to look again.
export const createHostProtection = (api: string, changed: () => void) => {
  const known = new Map<string, { branches: string[]; at: number }>();
  const loading = new Map<string, Promise<string[]>>();

  const load = (repository: string): Promise<string[]> => {
    const running = loading.get(repository);
    if (running) return running;
    const request = (async (): Promise<string[]> => {
      try {
        const response = await fetch(`${api}/repos/${repository}/branches?protected=true&per_page=100`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Glist Studio' },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return [];
        const branches = await response.json() as Array<{ name?: unknown }>;
        return Array.isArray(branches) ? branches.map((branch) => branch.name).filter((name): name is string => typeof name === 'string') : [];
      } catch {
        return [];
      }
    })().then((branches) => {
      // Until GitHub answers, none are taken as protected there.
      const before = known.get(repository)?.branches.join('\n') ?? '';
      known.set(repository, { branches, at: Date.now() });
      loading.delete(repository);
      if (before !== branches.join('\n')) changed();
      return branches;
    });
    loading.set(repository, request);
    return request;
  };

  // What is known now, asking again in the background when it is old. With
  // wait, a repository not asked about yet is waited for, as before a push.
  return async (url: string | null, wait = false): Promise<string[]> => {
    const repository = url ? githubRepository(url) : null;
    if (!repository) return [];
    const entry = known.get(repository);
    if (entry && Date.now() - entry.at < tenMinutes) return entry.branches;
    const request = load(repository);
    if (entry) return entry.branches;
    return wait ? request : [];
  };
};
