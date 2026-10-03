import { copyText } from './clipboard';
import { t } from './localization';
import { notify } from './notifications';

// Settings > About: which Glist Studio this is, and the branch and commit of the
// engine and the open project's plugins, to name when something goes wrong.
// Copy All puts the same as text on the clipboard, for a report.

type Head = GlistAbout['head'];

export class AboutView {
  private text = '';

  constructor(private readonly host: HTMLElement, copy: HTMLButtonElement) {
    copy.addEventListener('click', () => {
      void copyText(this.text).then(() => notify({ text: t('aboutCopied'), kind: 'success' }));
    });
  }

  async refresh(): Promise<void> {
    const about = await window.glistAPI.aboutInfo().catch((): null => null);
    if (!about) return;
    const lines: string[] = [];
    const group = (title: string, rows: Array<[string, string | Node]>, text: string[]): HTMLElement => {
      const section = document.createElement('section');
      section.className = 'about-group';
      const heading = document.createElement('h3');
      heading.textContent = title;
      const list = document.createElement('dl');
      list.className = 'about-list';
      rows.forEach(([name, value]) => {
        const term = document.createElement('dt');
        term.textContent = name;
        const detail = document.createElement('dd');
        detail.append(value);
        list.append(term, detail);
      });
      section.append(heading, list);
      lines.push(`${title}: ${text.join(', ')}`);
      return section;
    };
    const commit = (head: Head): string | Node => {
      if (!head?.commit) return t('aboutUnknown');
      const short = head.commit.slice(0, 10);
      if (!head.commitPage) return Object.assign(document.createElement('code'), { textContent: short, title: head.commit });
      return Object.assign(document.createElement('a'), {
        className: 'about-commit', textContent: short, title: head.commit, href: head.commitPage, target: '_blank', rel: 'noopener',
      });
    };
    const branch = (head: Head): string => head?.branch ?? t('aboutNoBranch');
    // What is known of a checkout, as rows and as text.
    const checkout = (repository: GlistAboutRepository): { rows: Array<[string, string | Node]>; text: string[] } => {
      if (!repository.found) return { rows: [[t('aboutFolder'), `${t('aboutNotFound')}: ${repository.location}`]], text: [`${t('aboutNotFound')} (${repository.location})`] };
      if (!repository.head) return { rows: [[t('aboutFolder'), repository.location], ['Git', t('aboutNotGit')]], text: [t('aboutNotGit'), repository.location] };
      return {
        rows: [[t('aboutBranch'), branch(repository.head)], [t('aboutCommit'), commit(repository.head)], [t('aboutFolder'), repository.location]],
        text: [branch(repository.head), repository.head.commit ?? t('aboutUnknown'), repository.location],
      };
    };

    const studio = group('Glist Studio', [
      [t('aboutVersion'), about.version],
      [t('aboutCommit'), commit(about.head)],
    ], [about.version, about.head?.commit ?? t('aboutUnknown')]);
    const engines = about.repositories.filter((repository) => repository.kind === 'engine').map((repository) => {
      const { rows, text } = checkout(repository);
      return group(repository.name, rows, text);
    });
    const plugins = about.repositories.filter((repository) => repository.kind === 'plugin');
    const pluginGroup = plugins.length === 0 ? [] : [group(t('aboutPlugins'), plugins.map((plugin) => {
      if (!plugin.found || !plugin.head) return [plugin.name, plugin.found ? t('aboutNotGit') : t('aboutNotFound')];
      const value = document.createElement('span');
      value.append(`${branch(plugin.head)}  `, commit(plugin.head));
      return [plugin.name, value];
    }), plugins.map((plugin) => `${plugin.name} ${plugin.head ? `${branch(plugin.head)} ${plugin.head.commit ?? ''}`.trim() : t(plugin.found ? 'aboutNotGit' : 'aboutNotFound')}`))];
    const system = group(t('aboutSystem'), about.runtime.map(({ name, version }) => [name, version]),
      about.runtime.map(({ name, version }) => `${name} ${version}`));
    this.host.replaceChildren(studio, ...engines, ...pluginGroup, system);
    this.text = `${lines.join('\n')}\n`;
  }
}
