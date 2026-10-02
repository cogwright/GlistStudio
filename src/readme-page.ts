// eslint-disable-next-line import/no-unresolved
import { Uri } from 'monaco-editor/editor/editor.api';
// Monaco's own Markdown renderer, the one its hovers use: marked, then DOMPurify
// with the tags and attributes VS Code allows in extensions' Markdown. It is not
// part of Monaco's public API, so a new monaco-editor may move it.
// eslint-disable-next-line import/no-unresolved
import { renderMarkdown } from 'monaco-editor/base/browser/markdownRenderer.js';
import { t } from './localization';

// A plugin's README in a tab of its own, opened from the Plugins view. It comes
// from GitHub or the plugin's folder, so it is never trusted: no commands and no
// scripts, only the HTML Markdown may have. Links open in the browser, and
// images it names by a relative path come from raw.githubusercontent.com.

export interface ReadmePage {
  name: string;
  readme?: GlistPluginReadme;
  error?: string;
}

// A /blob/ address is GitHub's page about a file; the file itself is on raw.githubusercontent.com.
const blobPage = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//;

export const renderReadmePage = (target: HTMLElement, page: ReadmePage): { dispose(): void } => {
  const line = (text: string): { dispose(): void } => {
    const paragraph = document.createElement('p');
    paragraph.className = 'readme-status';
    paragraph.textContent = text;
    target.replaceChildren(paragraph);
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
  target.replaceChildren(rendered.element);
  return rendered;
};
