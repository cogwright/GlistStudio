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
}

const fill = (key: TranslationKey, values: Record<string, string>): string =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(value), t(key));

const attempt = (target: CheckoutTarget, choice?: GlistUpdateChoice, resolve?: boolean): Promise<GlistCheckoutResult> =>
  target.run(choice, resolve).catch((error: Error): GlistCheckoutResult => ({ success: false, message: error.message }));

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
        { label: fill('updateUseSource', values), run: () => { void attempt(target, 'replace').then((next) => report(target, next, hooks, false)); } },
        ...(hooks.gitTools() ? [{
          label: t('updateResolve'),
          run: () => { void attempt(target, 'keep', true).then(() => hooks.showConflicts()); },
        }] : []),
      ],
    });
    return;
  }
  if (!result.success) {
    notify({ text: fill('checkoutUpdateFailed', values), detail: result.message, kind: 'error' });
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
  let result = await attempt(target);
  if (result.confirm) {
    const choice = await ask(target, result.confirm);
    if (!choice) return result;
    result = await attempt(target, choice);
  }
  report(target, result, hooks, quiet);
  return result;
};
