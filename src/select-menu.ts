import { showMenu } from './context-menu';
import { icon } from './icons';

// The studio's own dropdowns. A <select> stays in the page, out of sight, for
// its value and its change events, so the code using it is unchanged; a button
// in its place shows the chosen option and opens the options in the studio's
// menu (context-menu.ts), which looks like the rest of the studio, where the
// browser's own list did not. Every select is dressed so, those added later too.
// The select's classes go to its button, which they style and name; the select
// keeps its id, by which the code finds it.

const valueProperty = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const indexProperty = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

const dressSelect = (select: HTMLSelectElement): void => {
  if (select.dataset.dressed || select.multiple) return;
  select.dataset.dressed = 'yes';
  const button = document.createElement('button');
  button.type = 'button';
  const label = document.createElement('span');
  label.className = 'select-label';
  button.append(label, icon('chevron-down'));
  select.after(button);
  select.classList.add('dressed-select');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  button.className = 'select-button';
  const update = (): void => {
    const classes = [...select.classList].filter((name) => name !== 'dressed-select');
    if (classes.length) {
      button.classList.add(...classes);
      select.classList.remove(...classes);
    }
    label.textContent = select.selectedOptions[0]?.textContent ?? '';
    button.hidden = select.hidden;
    button.disabled = select.disabled;
    button.title = select.title;
    const name = select.getAttribute('aria-label') ?? [...select.labels].map((each) => each.textContent).join(' ');
    if (name) button.setAttribute('aria-label', name);
  };
  // Changed by the code: options, hidden, disabled, a title or the value itself.
  new MutationObserver(update).observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
  select.addEventListener('change', update);
  Object.defineProperty(select, 'value', {
    configurable: true,
    get: () => valueProperty.get.call(select),
    set: (value: string) => { valueProperty.set.call(select, value); update(); },
  });
  Object.defineProperty(select, 'selectedIndex', {
    configurable: true,
    get: () => indexProperty.get.call(select),
    set: (index: number) => { indexProperty.set.call(select, index); update(); },
  });

  const choose = (option: HTMLOptionElement): void => {
    if (option.selected) return;
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const open = (): void => {
    const box = button.getBoundingClientRect();
    button.setAttribute('aria-expanded', 'true');
    showMenu({ clientX: box.left, clientY: box.bottom + 2 }, [...select.options].map((option) => ({
      label: option.textContent ?? '', checked: option.selected, disabled: option.disabled, run: () => choose(option),
    })), { minWidth: box.width, from: button, onClose: () => button.setAttribute('aria-expanded', 'false') });
  };
  button.setAttribute('aria-haspopup', 'listbox');
  button.addEventListener('click', (event) => { event.stopPropagation(); open(); });
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open();
    }
  });
  // A label for the select brings its button forward instead.
  [...select.labels].forEach((each) => each.addEventListener('click', (event) => { event.preventDefault(); button.focus(); }));
  update();
};

export const dressSelects = (root: ParentNode = document): void => {
  root.querySelectorAll('select').forEach(dressSelect);
  new MutationObserver((changes) => changes.forEach((change) => change.addedNodes.forEach((node) => {
    if (node instanceof HTMLSelectElement) dressSelect(node);
    else if (node instanceof HTMLElement) node.querySelectorAll('select').forEach(dressSelect);
  }))).observe(document.body, { childList: true, subtree: true });
};
