import { icon } from './icons';
import { shortcutLabel } from './shortcuts';

// The studio's right-click menu, which the explorer, the Git views and the
// editor share, so they look and behave alike.

export type MenuEntry =
  | { label: string; run: () => void; shortcut?: string; danger?: boolean; disabled?: boolean }
  | { label: string; children: MenuEntry[] }
  | 'separator';

const menu = document.createElement('div');
menu.className = 'context-menu';
menu.setAttribute('role', 'menu');
menu.hidden = true;
document.body.append(menu);

// Where focus was before the menu took it from the keyboard, to give it back.
let returnFocus: HTMLElement | null = null;

export const closeMenu = (): void => {
  if (menu.hidden) return;
  menu.hidden = true;
  returnFocus?.focus();
  returnFocus = null;
};
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);

// Up and down move through the items, as in the title bar's menus.
menu.addEventListener('keydown', (event) => {
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.context-item:not(:disabled)')]
    .filter((item) => item.offsetParent !== null);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});

// The browser build's CSS zoom, by which mouse positions are divided.
const pageZoom = (): number => Number(document.documentElement.style.getPropertyValue('--page-zoom')) || 1;

const itemNode = (entry: Exclude<MenuEntry, 'separator'>): HTMLElement => {
  const item = document.createElement('button');
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  if ('children' in entry) {
    // A submenu opens beside its item when pointed at, or on a click.
    const group = document.createElement('div');
    group.className = 'context-group';
    item.className = 'context-item has-submenu';
    item.setAttribute('aria-haspopup', 'menu');
    item.append(entry.label, icon('chevron-right'));
    item.addEventListener('click', (event) => { event.stopPropagation(); group.classList.toggle('expanded'); });
    const submenu = document.createElement('div');
    submenu.className = 'context-submenu';
    submenu.append(...entry.children.map(entryNode));
    group.append(item, submenu);
    return group;
  }
  item.className = `context-item${entry.danger ? ' danger' : ''}`;
  item.disabled = Boolean(entry.disabled);
  const label = document.createElement('span');
  label.textContent = entry.label;
  item.append(label);
  if (entry.shortcut) {
    const shortcut = document.createElement('kbd');
    shortcut.textContent = shortcutLabel(entry.shortcut);
    item.append(shortcut);
  }
  item.addEventListener('click', () => { closeMenu(); entry.run(); });
  return item;
};

const entryNode = (entry: MenuEntry): HTMLElement => {
  if (entry !== 'separator') return itemNode(entry);
  const separator = document.createElement('div');
  separator.className = 'context-separator';
  return separator;
};

// Opens at the mouse, or at a point given for a menu opened from the keyboard,
// whose first item then takes focus.
export const showMenu = (at: MouseEvent | { clientX: number; clientY: number }, entries: MenuEntry[]): void => {
  const fromKeyboard = !(at instanceof MouseEvent);
  if (at instanceof MouseEvent) {
    at.preventDefault();
    at.stopPropagation();
  }
  // Separators at either end or next to each other, left by entries not shown.
  const shown = entries.reduce<MenuEntry[]>((list, entry) =>
    (entry === 'separator' && (list.length === 0 || list[list.length - 1] === 'separator') ? list : [...list, entry]), []);
  if (shown[shown.length - 1] === 'separator') shown.pop();
  menu.replaceChildren(...shown.map(entryNode));
  returnFocus = fromKeyboard && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  menu.hidden = false;
  const zoom = pageZoom();
  const width = menu.offsetWidth * zoom;
  const height = menu.offsetHeight * zoom;
  const left = Math.max(0, Math.min(at.clientX, window.innerWidth - width - 6));
  menu.classList.toggle('submenu-left', left + width + 210 * zoom > window.innerWidth);
  menu.style.left = `${left / zoom}px`;
  menu.style.top = `${Math.max(0, Math.min(at.clientY, window.innerHeight - height - 6)) / zoom}px`;
  if (fromKeyboard) menu.querySelector<HTMLButtonElement>('.context-item:not(:disabled)')?.focus();
};
