// A right-click menu for the Git views, drawn like the explorer's.

export type MenuEntry = { label: string; run: () => void; danger?: boolean; disabled?: boolean } | 'separator';

const menu = document.createElement('div');
menu.className = 'explorer-context-menu';
menu.setAttribute('role', 'menu');
menu.hidden = true;
document.body.append(menu);

const close = (): void => { menu.hidden = true; };
document.addEventListener('click', close);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
window.addEventListener('blur', close);
window.addEventListener('resize', close);

// The browser build's CSS zoom, by which mouse positions are divided.
const pageZoom = (): number => Number(document.documentElement.style.getPropertyValue('--page-zoom')) || 1;

export const showMenu = (event: MouseEvent, entries: MenuEntry[]): void => {
  event.preventDefault();
  event.stopPropagation();
  menu.replaceChildren(...entries.map((entry) => {
    if (entry === 'separator') {
      const separator = document.createElement('div');
      separator.className = 'context-separator';
      return separator;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `context-item${entry.danger ? ' danger' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.textContent = entry.label;
    item.disabled = Boolean(entry.disabled);
    item.addEventListener('click', () => { close(); entry.run(); });
    return item;
  }));
  menu.hidden = false;
  const zoom = pageZoom();
  const width = menu.offsetWidth * zoom;
  const height = menu.offsetHeight * zoom;
  menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - width - 6)) / zoom}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - height - 6)) / zoom}px`;
};
