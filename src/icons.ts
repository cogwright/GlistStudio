import add from '@vscode/codicons/src/icons/add.svg';
import chevronRight from '@vscode/codicons/src/icons/chevron-right.svg';
import circleFilled from '@vscode/codicons/src/icons/circle-filled.svg';
import clearAll from '@vscode/codicons/src/icons/clear-all.svg';
import close from '@vscode/codicons/src/icons/close.svg';
import debugAlt from '@vscode/codicons/src/icons/debug-alt.svg';
import debugContinue from '@vscode/codicons/src/icons/debug-continue.svg';
import debugPause from '@vscode/codicons/src/icons/debug-pause.svg';
import debugStepInto from '@vscode/codicons/src/icons/debug-step-into.svg';
import debugStepOut from '@vscode/codicons/src/icons/debug-step-out.svg';
import debugStepOver from '@vscode/codicons/src/icons/debug-step-over.svg';
import debugStop from '@vscode/codicons/src/icons/debug-stop.svg';
import extensions from '@vscode/codicons/src/icons/extensions.svg';
import files from '@vscode/codicons/src/icons/files.svg';
import folder from '@vscode/codicons/src/icons/folder.svg';
import folderOpened from '@vscode/codicons/src/icons/folder-opened.svg';
import newFile from '@vscode/codicons/src/icons/new-file.svg';
import newFolder from '@vscode/codicons/src/icons/new-folder.svg';
import packageIcon from '@vscode/codicons/src/icons/package.svg';
import play from '@vscode/codicons/src/icons/play.svg';
import refresh from '@vscode/codicons/src/icons/refresh.svg';
import save from '@vscode/codicons/src/icons/save.svg';
import settingsGear from '@vscode/codicons/src/icons/settings-gear.svg';
import tools from '@vscode/codicons/src/icons/tools.svg';
import trash from '@vscode/codicons/src/icons/trash.svg';
import warning from '@vscode/codicons/src/icons/warning.svg';
import zoomIn from '@vscode/codicons/src/icons/zoom-in.svg';
import zoomOut from '@vscode/codicons/src/icons/zoom-out.svg';
import arrowDown from '@vscode/codicons/src/icons/arrow-down.svg';
import arrowUp from '@vscode/codicons/src/icons/arrow-up.svg';
import check from '@vscode/codicons/src/icons/check.svg';
import cloudDownload from '@vscode/codicons/src/icons/cloud-download.svg';
import sync from '@vscode/codicons/src/icons/sync.svg';
import copy from '@vscode/codicons/src/icons/copy.svg';
import diff from '@vscode/codicons/src/icons/diff.svg';
import discard from '@vscode/codicons/src/icons/discard.svg';
import gitBranch from '@vscode/codicons/src/icons/git-branch.svg';
import gitCompare from '@vscode/codicons/src/icons/git-compare.svg';
import gitMerge from '@vscode/codicons/src/icons/git-merge.svg';
import gitStash from '@vscode/codicons/src/icons/git-stash.svg';
import gitStashApply from '@vscode/codicons/src/icons/git-stash-apply.svg';
import gitStashPop from '@vscode/codicons/src/icons/git-stash-pop.svg';
import goToFile from '@vscode/codicons/src/icons/go-to-file.svg';
import historyIcon from '@vscode/codicons/src/icons/history.svg';
import remote from '@vscode/codicons/src/icons/remote.svg';
import repoFetch from '@vscode/codicons/src/icons/repo-fetch.svg';
import repoPull from '@vscode/codicons/src/icons/repo-pull.svg';
import repoPush from '@vscode/codicons/src/icons/repo-push.svg';
import search from '@vscode/codicons/src/icons/search.svg';
import sourceControl from '@vscode/codicons/src/icons/source-control.svg';
import tag from '@vscode/codicons/src/icons/tag.svg';
import edit from '@vscode/codicons/src/icons/edit.svg';
import splitHorizontal from '@vscode/codicons/src/icons/split-horizontal.svg';
import chevronUp from '@vscode/codicons/src/icons/chevron-up.svg';
import chevronDown from '@vscode/codicons/src/icons/chevron-down.svg';
import info from '@vscode/codicons/src/icons/info.svg';
import errorIcon from '@vscode/codicons/src/icons/error.svg';

// Interface icons: Codicons, the set VS Code uses (CC BY 4.0, see THIRD_PARTY_NOTICES.md).
// They are inline SVG, so they take the color of the text around them.
const icons = {
  add,
  'arrow-down': arrowDown,
  'arrow-up': arrowUp,
  check,
  'chevron-down': chevronDown,
  'chevron-right': chevronRight,
  'chevron-up': chevronUp,
  'circle-filled': circleFilled,
  'clear-all': clearAll,
  close,
  'cloud-download': cloudDownload,
  copy,
  'debug-alt': debugAlt,
  'debug-continue': debugContinue,
  'debug-pause': debugPause,
  'debug-step-into': debugStepInto,
  'debug-step-out': debugStepOut,
  'debug-step-over': debugStepOver,
  'debug-stop': debugStop,
  diff,
  discard,
  edit,
  error: errorIcon,
  extensions,
  files,
  folder,
  'folder-opened': folderOpened,
  'git-branch': gitBranch,
  'git-compare': gitCompare,
  'git-merge': gitMerge,
  'git-stash': gitStash,
  'git-stash-apply': gitStashApply,
  'git-stash-pop': gitStashPop,
  'go-to-file': goToFile,
  history: historyIcon,
  info,
  'new-file': newFile,
  'new-folder': newFolder,
  package: packageIcon,
  play,
  refresh,
  remote,
  'repo-fetch': repoFetch,
  'repo-pull': repoPull,
  'repo-push': repoPush,
  save,
  search,
  'settings-gear': settingsGear,
  'source-control': sourceControl,
  'split-horizontal': splitHorizontal,
  sync,
  tag,
  tools,
  trash,
  warning,
  'zoom-in': zoomIn,
  'zoom-out': zoomOut,
};

export type IconName = keyof typeof icons;

export const icon = (name: IconName): SVGSVGElement => {
  const template = document.createElement('template');
  template.innerHTML = icons[name];
  const svg = template.content.firstElementChild as SVGSVGElement;
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  return svg;
};

// The page marks where icons go with <i data-icon="name"></i>.
export const placeIcons = (root: ParentNode = document): void => {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((placeholder) => {
    const name = placeholder.dataset.icon as IconName;
    if (name in icons) placeholder.replaceWith(icon(name));
  });
};
