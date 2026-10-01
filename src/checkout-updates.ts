import { formDialog } from './git-dialogs';
import { t, type TranslationKey } from './localization';
import { notify } from './notifications';

// Updating the engine or a plugin from where it is published, the same way
// for both (checkout-update.ts does the work): straight on when nothing of the
// user's own is in the way, otherwise asking whether to keep their work on
// top of the new version or put it aside. A conflict changes nothing, and can
// be left for the Git tools to resolve when they are on.

export interface CheckoutTarget {
  name: string;
  // Where it is updated from, in words: GlistEngine/GlistEngine, GlistPlugins, or owner/name.
  source: string;
  run(choice?: GlistUpdateChoice, resolve?: boolean): Promise<GlistCheckoutResult>;
}

export interface CheckoutUpdateHooks {
  gitTools(): boolean;
  // Conflicts were left in place: show where to resolve them.
  showConflicts(): void;
  // The Git console, where the update's commands are, with what git said.
  showConsole(): void;
  // Before: open files saved, so changes typed are among those kept. False stops the update.
  save(): Promise<boolean>;
  // After: open files and the explorer read again, since git changed them on disk.
  reload(): Promise<void>;
}

const fill = (key: TranslationKey, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), t(key));

const attempt = (target: CheckoutTarget, choice?: GlistUpdateChoice, resolve?: boolean): Promise<GlistCheckoutResult> =>
  target.run(choice, resolve).catch((error: Error): GlistCheckoutResult => ({ success: false, message: error.message }));

// An update that may change files: saved first, read again after.
const change = async (target: CheckoutTarget, hooks: CheckoutUpdateHooks, choice?: GlistUpdateChoice, resolve?: boolean): Promise<GlistCheckoutResult> => {
  if (!(await hooks.save())) return { success: false, message: '' };
  const result = await attempt(target, choice, resolve);
  if (!result.confirm && !result.upToDate) await hooks.reload();
  return result;
};

// Keep or replace, with what each does to this work.
const ask = async (target: CheckoutTarget, confirm: NonNullable<GlistCheckoutResult['confirm']>): Promise<GlistUpdateChoice | null> => {
  const values = { name: target.name, source: target.source };
  const count = (one: TranslationKey, many: TranslationKey, value: number): string => (value === 1 ? t(one) : fill(many, { count: String(value) }));
  const work = [
    ...(confirm.changed > 0 ? [count('updateWorkFile', 'updateWorkFiles', confirm.changed)] : []),
    ...(confirm.ahead > 0 ? [count('updateWorkCommit', 'updateWorkCommits', confirm.ahead)] : []),
  ].join(t('updateWorkAnd'));
  const keep = confirm.ahead === 0 ? 'updateKeepFiles' : confirm.keepBy === 'merge' ? 'updateKeepMerge' : 'updateKeepRebase';
  // Why a merge, or what a rebase of pushed commits means for the next push.
  const why = !confirm.pushedTo ? '' : confirm.keepBy === 'merge'
    ? fill('updateKeepMergeWhy', { branch: confirm.pushedTo }) : fill('updateKeepRebasePushed', { branch: confirm.pushedTo });
  const answer = await formDialog({
    title: fill('updateAskTitle', values),
    hint: [fill('updateAskHint', { ...values, work }), why].filter(Boolean).join(' '),
    fields: [{
      kind: 'choice',
      key: 'how',
      options: [{ value: 'keep', label: t(keep) }, {
        value: 'replace',
        label: fill(confirm.ahead === 0 ? 'updateReplaceFiles' : confirm.changed === 0 ? 'updateReplaceCommits' : 'updateReplace', values),
      }],
      value: 'keep',
    }],
    submit: t('updateButton'),
  });
  return answer ? (answer.how === 'replace' ? 'replace' : 'keep') : null;
};

// Says how it went, with the way on after a conflict.
const report = (target: CheckoutTarget, result: GlistCheckoutResult, hooks: CheckoutUpdateHooks, quiet: boolean): void => {
  const values = { name: target.name, source: target.source };
  const showConsole = hooks.gitTools() ? [{ label: t('showConsole'), run: () => hooks.showConsole() }] : [];
  if (result.upToDate) {
    if (!quiet) notify({ text: fill('updateUpToDate', values), kind: 'success' });
    return;
  }
  if (result.conflicts) {
    notify({
      text: result.message,
      detail: t('updateNothingChanged'),
      kind: 'error',
      actions: [
        { label: fill('updateUseSource', values), run: () => { void change(target, hooks, 'replace').then((next) => report(target, next, hooks, false)); } },
        ...(hooks.gitTools() ? [{
          label: t('updateResolve'),
          run: () => { void change(target, hooks, 'keep', true).then(() => hooks.showConflicts()); },
        }] : []),
        ...showConsole,
      ],
    });
    return;
  }
  if (!result.success) {
    // Saving failed and said so already.
    if (result.message) notify({ text: fill('checkoutUpdateFailed', values), detail: result.message, kind: 'error', actions: showConsole });
    return;
  }
  const done: Record<NonNullable<GlistCheckoutResult['how']>, TranslationKey> = {
    'fast-forward': 'updateDoneFastForward', rebase: 'updateDoneRebase', merge: 'updateDoneMerge', replace: 'updateDoneReplace',
  };
  const detail = [
    ...(result.kept?.branch ? [fill('updateKeptBranch', { branch: result.kept.branch })] : []),
    ...(result.kept?.stash ? [fill('updateKeptStash', { stash: result.kept.stash })] : []),
    ...(result.stashClash ? [t('updateStashClash')] : []),
  ].join(' ');
  notify({ text: fill(done[result.how ?? 'fast-forward'], values), kind: 'success', ...(detail ? { detail } : {}) });
};

// Updates one, asking first when there is work of the user's own. Quiet
// leaves out the message that it was up to date already, for updates of several.
export const updateCheckout = async (target: CheckoutTarget, hooks: CheckoutUpdateHooks, quiet = false): Promise<GlistCheckoutResult> => {
  let result = await change(target, hooks);
  if (result.confirm) {
    const choice = await ask(target, result.confirm);
    if (!choice) return result;
    result = await change(target, hooks, choice);
  }
  report(target, result, hooks, quiet);
  return result;
};
