// Git for the Commit view and the Git panel, through the git command. The
// parsers read git's machine-readable output and are tested on their own.

export type GitFileState = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | 'typechange';

export interface GitFileChange {
  path: string;
  // For a rename, where it came from.
  from?: string;
  state: GitFileState;
  // Whether the index holds changes to it, beyond HEAD.
  staged: boolean;
  // For a conflict, git's two-letter code, such as UU.
  conflict?: string;
}

export interface GitStatus {
  branch: string | null;
  // The commit HEAD is at; null before the first commit.
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  // Ignored files, and folders ending in /.
  ignored: string[];
}

const stateOf = (code: string): GitFileState => {
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R' || code === 'C') return 'renamed';
  if (code === 'T') return 'typechange';
  return 'modified';
};

// git status --porcelain=v2 --branch -z --untracked-files=all --ignored=matching
export const parseStatus = (output: string): GitStatus => {
  const status: GitStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, changes: [], ignored: [] };
  const fields = output.split('\0');
  for (let index = 0; index < fields.length; index += 1) {
    const line = fields[index];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length);
      status.head = oid === '(initial)' ? null : oid;
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      status.branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const [ahead, behind] = line.slice('# branch.ab '.length).split(' ');
      status.ahead = Math.abs(Number(ahead));
      status.behind = Math.abs(Number(behind));
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const parts = line.split(' ');
      const [x, y] = parts[1];
      status.changes.push({
        path: parts.slice(8).join(' '), state: stateOf(x !== '.' ? x : y), staged: x !== '.',
      });
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next field
      const parts = line.split(' ');
      const [x] = parts[1];
      status.changes.push({ path: parts.slice(9).join(' '), from: fields[index + 1], state: 'renamed', staged: x !== '.' });
      index += 1;
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = line.split(' ');
      status.changes.push({ path: parts.slice(10).join(' '), state: 'conflict', staged: false, conflict: parts[1] });
    } else if (line.startsWith('? ')) {
      status.changes.push({ path: line.slice(2), state: 'untracked', staged: false });
    } else if (line.startsWith('! ')) {
      status.ignored.push(line.slice(2));
    }
  }
  return status;
};

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  // Seconds since the epoch.
  date: number;
  // Branches and tags pointing at it, as git log %D prints them.
  refs: string[];
  subject: string;
}

export const logFormat = '%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e';

export const parseLog = (output: string): GitCommit[] => output.split('\x1e')
  .map((record) => record.replace(/^\n/, ''))
  .filter((record) => record.includes('\x1f'))
  .map((record) => {
    const [hash, short, parents, author, email, date, refs, subject] = record.split('\x1f');
    return {
      hash,
      short,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      // A remote's HEAD only names one of its branches, which is listed too.
      refs: refs ? refs.split(', ').map((ref) => ref.replace(/^HEAD -> /, '')).filter((ref) => ref !== 'HEAD' && !ref.endsWith('/HEAD')) : [],
      subject,
    };
  });

export interface GitCommitFile {
  path: string;
  from?: string;
  state: GitFileState;
}

// git diff --name-status -z -M: a status, then one path, or two for a rename or copy.
export const parseNameStatus = (output: string): GitCommitFile[] => {
  const fields = output.split('\0').filter((field) => field !== '');
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index][0];
    if (code === 'R' || code === 'C') {
      files.push({ from: fields[index + 1], path: fields[index + 2], state: 'renamed' });
      index += 2;
    } else {
      files.push({ path: fields[index + 1], state: stateOf(code) });
      index += 1;
    }
  }
  return files;
};

export interface GitBranch {
  // refs/heads/main or refs/remotes/origin/main
  ref: string;
  name: string;
  remote: boolean;
  current: boolean;
  commit: string;
  upstream: string | null;
  // The upstream branch was deleted.
  gone: boolean;
  ahead: number;
  behind: number;
  // Seconds since the epoch.
  date: number;
  subject: string;
}

// Branches and tags by name, as people look for them: numbers in a name by
// their value, so a-9 comes before a-10, and a remote's branches side by side.
const byName = new Intl.Collator('en', { numeric: true }).compare;

// %(upstream:track) is translated, so this runs with LC_ALL=C.
export const branchFormat = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:unix)%1f%(subject)%1e';

export const parseBranches = (output: string): GitBranch[] => output.split('\x1e')
  .map((record) => record.replace(/^\n/, ''))
  .filter((record) => record.includes('\x1f'))
  .map((record) => {
    const [ref, name, commit, upstream, track, head, date, subject] = record.split('\x1f');
    return {
      ref,
      name,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      commit,
      upstream: upstream || null,
      gone: track === '[gone]',
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      date: Number(date),
      subject,
    };
  })
  // A remote's HEAD is an alias of one of its branches.
  .filter((branch) => !branch.ref.endsWith('/HEAD'))
  // The local ones first.
  .sort((left, right) => Number(left.remote) - Number(right.remote) || byName(left.name, right.name));

export interface GitTag {
  name: string;
  commit: string;
  // Seconds since the epoch.
  date: number;
  subject: string;
}

// An annotated tag points at a tag object, whose commit is %(*objectname).
export const tagFormat = '%(refname:short)%1f%(if)%(*objectname)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)%1f%(creatordate:unix)%1f%(subject)%1e';

export const parseTags = (output: string): GitTag[] => output.split('\x1e')
  .map((record) => record.replace(/^\n/, ''))
  .filter((record) => record.includes('\x1f'))
  .map((record) => {
    const [name, commit, date, subject] = record.split('\x1f');
    return { name, commit, date: Number(date), subject };
  })
  .sort((left, right) => byName(left.name, right.name));

export interface GitRemote {
  name: string;
  fetch: string;
  push: string;
}

// git remote -v
export const parseRemotes = (output: string): GitRemote[] => {
  const remotes = new Map<string, GitRemote>();
  output.split('\n').forEach((line) => {
    const match = /^(\S+)\t(\S+) \((fetch|push)\)$/.exec(line.trim());
    if (!match) return;
    const remote = remotes.get(match[1]) ?? { name: match[1], fetch: '', push: '' };
    remote[match[3] as 'fetch' | 'push'] = match[2];
    remotes.set(match[1], remote);
  });
  return [...remotes.values()];
};

export interface GitStash {
  // stash@{0}
  name: string;
  message: string;
  date: number;
}

export const stashFormat = '%gd%x1f%gs%x1f%at%x1e';

export const parseStashes = (output: string): GitStash[] => output.split('\x1e')
  .map((record) => record.replace(/^\n/, ''))
  .filter((record) => record.includes('\x1f'))
  .map((record) => {
    const [name, message, date] = record.split('\x1f');
    return { name, message, date: Number(date) };
  });

export interface GitBlameLine {
  commit: string;
  author: string;
  // Seconds since the epoch.
  date: number;
  summary: string;
  // Not yet committed.
  uncommitted: boolean;
}

// git blame --line-porcelain: a header per line, then the line itself after a tab.
export const parseBlame = (output: string): GitBlameLine[] => {
  const lines: GitBlameLine[] = [];
  let current: GitBlameLine | null = null;
  output.split('\n').forEach((line) => {
    if (line.startsWith('\t')) {
      if (current) lines.push(current);
      current = null;
    } else if (!current) {
      const commit = line.split(' ')[0];
      current = { commit, author: '', date: 0, summary: '', uncommitted: /^0+$/.test(commit) };
    } else if (line.startsWith('author ')) {
      current.author = line.slice('author '.length);
    } else if (line.startsWith('author-time ')) {
      current.date = Number(line.slice('author-time '.length));
    } else if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length);
    }
  });
  return lines;
};
