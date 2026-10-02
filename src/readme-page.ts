// eslint-disable-next-line import/no-unresolved
import { Uri } from 'monaco-editor/editor/editor.api';
// Monaco's own Markdown renderer, the one its hovers use: marked, then DOMPurify
// with the tags and attributes VS Code allows in extensions' Markdown. It is not
// part of Monaco's public API, so a new monaco-editor may move it.
// eslint-disable-next-line import/no-unresolved
import { renderMarkdown } from 'monaco-editor/base/browser/markdownRenderer.js';
import { icon } from './icons';
import { t } from './localization';

// A plugin's README in a tab of its own, opened from the Plugins view. It comes
// from GitHub or the plugin's folder, so it is never trusted: no commands and no
// scripts, only the HTML Markdown may have. Links open in the browser, and
// images it names by a relative path come from raw.githubusercontent.com.

export interface ReadmePage {
  name: string;
  // Its page on GitHub, for one GitHub lists; empty otherwise.
  url: string;
  readme?: GlistPluginReadme;
  error?: string;
}

// A /blob/ address is GitHub's page about a file; the file itself is on raw.githubusercontent.com.
const blobPage = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//;

// Above the README, staying in sight while it scrolls: its page on GitHub, in the browser.
const toolbar = (page: ReadmePage): HTMLElement[] => {
  if (!/^https:\/\/github\.com\//.test(page.url)) return [];
  const bar = document.createElement('div');
  bar.className = 'readme-toolbar';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'readme-github';
  open.append(icon('github'), Object.assign(document.createElement('span'), { textContent: t('readmeOnGithub') }));
  open.addEventListener('click', () => { window.open(`${page.url}#readme`, '_blank', 'noopener'); });
  bar.append(open);
  return [bar];
};

export const renderReadmePage = (target: HTMLElement, page: ReadmePage): { dispose(): void } => {
  const line = (text: string): { dispose(): void } => {
    const paragraph = document.createElement('p');
    paragraph.className = 'readme-status';
    paragraph.textContent = text;
    target.replaceChildren(...toolbar(page), paragraph);
    return { dispose: () => undefined };
  };
  if (page.error) return line(`${t('readmeFailed')}: ${page.error}`);
  if (!page.readme) return line(t('readmeLoading'));
  if (!page.readme.text.trim()) return line(t('readmeNone').replace('{name}', page.name));
  const rendered = renderMarkdown(
    { value: page.readme.text, supportHtml: true, isTrusted: false, baseUri: Uri.parse(page.readme.page) },
    { actionHandler: (link) => { if (/^(https?|mailto):/i.test(link)) window.open(link, '_blank', 'noopener'); } },
  );
  rendered.element.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? '';
    if (blobPage.test(source)) image.setAttribute('src', source.replace(blobPage, 'https://raw.githubusercontent.com/$1/'));
  });
  rendered.element.className = 'readme-body';
  target.replaceChildren(...toolbar(page), rendered.element);
  return rendered;
};
