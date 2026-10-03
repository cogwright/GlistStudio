import { copyText } from './clipboard';
import type { GitClient } from './git-client';
import { t } from './localization';
import { notify } from './notifications';

// Patches to share: commits or changes copied to the clipboard or saved as a
// file, and brought into a repository from either. The backend makes and
// applies them (git-service.ts); here they travel as text, so a browser can
// save and read them as well as Electron can.

// What a patch starts with: a commit from git format-patch, or a diff.
const looksLikePatch = (text: string): boolean => /^(diff --git |--- |From [0-9a-f]{40} )/m.test(text);

const nothing = (made: GlistGitPatch): boolean => {
  if (made.patch.trim()) return false;
  notify({ text: t('patchNothing'), kind: 'error' });
  return true;
};

export const copyPatch = async (made: GlistGitPatch): Promise<void> => {
  if (nothing(made)) return;
  await copyText(made.patch);
  notify({ text: made.commits > 1 ? t('patchCopiedCommits').replace('{count}', String(made.commits)) : t('patchCopied'), kind: 'success' });
};

// A download, which Electron shows a Save dialog for.
export const savePatch = (made: GlistGitPatch): void => {
  if (nothing(made)) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([made.patch], { type: 'text/x-diff' }));
  link.download = made.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 60000);
};

// Applies patches in order, stopping at the first that does not go in. The
// client says why, or shows the conflicts to resolve.
const apply = async (client: GitClient, texts: string[], root?: string): Promise<void> => {
  for (const text of texts) {
    if (!looksLikePatch(text)) {
      notify({ text: t('patchNotOne'), kind: 'error' });
      return;
    }
    const result = await client.run({ kind: 'apply-patch', patch: text }, { root });
    if (!result.success) return;
    notify({ text: result.message, kind: 'success' });
  }
};

// .patch and .diff files the user picks, in name order, so 0001- comes before 0002-.
const pickFiles = (): Promise<string[]> => new Promise((resolve) => {
  const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: '.patch,.diff,.txt' });
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    void Promise.all(files.map((file) => file.text())).then(resolve);
  });
  input.addEventListener('cancel', () => resolve([]));
  input.click();
});

export const applyPatchFiles = async (client: GitClient, root?: string): Promise<void> => {
  const texts = await pickFiles();
  if (texts.length > 0) await apply(client, texts, root);
};

export const applyPatchFromClipboard = async (client: GitClient, root?: string): Promise<void> => {
  const text = await navigator.clipboard.readText().catch(() => '');
  if (!looksLikePatch(text)) {
    notify({ text: t('patchNotInClipboard'), kind: 'error' });
    return;
  }
  await apply(client, [text], root);
};
