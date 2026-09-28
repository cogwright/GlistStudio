import { icon } from './icons';
import { getLanguage, t } from './localization';

// Open Project: the projects in myglistapps and the ones opened before, most
// recently opened first, with a search box. Browse picks any other folder.

export interface ProjectPickerControls {
  dialog: HTMLDialogElement;
  filter: HTMLInputElement;
  list: HTMLElement;
  empty: HTMLElement;
  browse: HTMLButtonElement;
  create: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

export interface ProjectPickerActions {
  open: (root: string) => void;
  browse: () => void;
  create: () => void;
}

const opened = (time: number | undefined): string => {
  if (!time) return t('neverOpened');
  const minutes = Math.round((time - Date.now()) / 60000);
  const format = new Intl.RelativeTimeFormat(getLanguage(), { numeric: 'auto' });
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = Math.abs(minutes) < 60 ? [minutes, 'minute']
    : Math.abs(minutes) < 60 * 24 ? [Math.round(minutes / 60), 'hour']
      : Math.abs(minutes) < 60 * 24 * 30 ? [Math.round(minutes / (60 * 24)), 'day']
        : [Math.round(minutes / (60 * 24 * 30)), 'month'];
  return t('lastOpened').replace('{time}', format.format(value, unit));
};

export const setUpProjectPicker = (controls: ProjectPickerControls, actions: ProjectPickerActions): (() => Promise<void>) => {
  let projects: GlistProjectSummary[] = [];

  const choose = (root: string): void => {
    controls.dialog.close();
    actions.open(root);
  };

  const render = (): void => {
    const query = controls.filter.value.trim().toLowerCase();
    const shown = projects.filter((project) => !query || project.name.toLowerCase().includes(query) || project.root.toLowerCase().includes(query));
    controls.list.replaceChildren(...shown.map((project) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'project-item';
      item.setAttribute('role', 'option');
      item.title = project.root;
      const folder = document.createElement('span');
      folder.className = 'project-item-icon';
      folder.append(icon('folder'));
      const name = document.createElement('span');
      name.className = 'project-item-name';
      name.textContent = project.name;
      const where = document.createElement('span');
      where.className = 'project-item-path';
      where.textContent = project.location;
      const when = document.createElement('span');
      when.className = 'project-item-time';
      when.textContent = opened(project.lastOpened);
      item.append(folder, name, when, where);
      item.addEventListener('click', () => choose(project.root));
      return item;
    }));
    controls.empty.hidden = shown.length > 0;
  };

  controls.filter.addEventListener('input', render);
  // Enter opens the first match; the arrow keys move through the list.
  controls.filter.addEventListener('keydown', (event) => {
    const first = controls.list.querySelector<HTMLButtonElement>('.project-item');
    if (event.key === 'Enter' && first) { event.preventDefault(); first.click(); }
    if (event.key === 'ArrowDown' && first) { event.preventDefault(); first.focus(); }
  });
  controls.list.addEventListener('keydown', (event) => {
    const current = document.activeElement;
    if (!(current instanceof HTMLElement) || !current.classList.contains('project-item')) return;
    const next = event.key === 'ArrowDown' ? current.nextElementSibling : event.key === 'ArrowUp' ? current.previousElementSibling : null;
    if (event.key === 'ArrowUp' && !current.previousElementSibling) { event.preventDefault(); controls.filter.focus(); return; }
    if (next instanceof HTMLElement) { event.preventDefault(); next.focus(); }
  });
  controls.browse.addEventListener('click', () => { controls.dialog.close(); actions.browse(); });
  controls.create.addEventListener('click', () => { controls.dialog.close(); actions.create(); });
  controls.cancel.addEventListener('click', () => controls.dialog.close());

  return async () => {
    controls.filter.value = '';
    projects = await window.glistAPI.listProjects().catch((): GlistProjectSummary[] => []);
    render();
    controls.dialog.showModal();
    controls.filter.focus();
  };
};
