// Once Glist Engine is installed and a project is open, a word asking for a star
// on GlistEngine/GlistEngine at GitHub. Star opens the page and it never asks
// again; Not Now, or Escape, asks once more a week later, and then never again.

export interface StarPromptControls {
  dialog: HTMLDialogElement;
  star: HTMLButtonElement;
}

// Empty before it has asked, then when to ask again, then done.
const key = 'glist-studio-star-prompt';
const week = 7 * 24 * 60 * 60 * 1000;

const read = (): string => {
  try { return window.localStorage.getItem(key) ?? ''; } catch { return 'done'; }
};
const write = (value: string): void => {
  try { window.localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
};
const due = (): boolean => {
  const value = read();
  return value === '' || (/^\d+$/.test(value) && Date.now() >= Number(value));
};

// Waits until no other dialog is open, such as the installer's.
const noDialogOpen = (): Promise<void> => new Promise((resolve) => {
  const check = (): void => {
    const open = document.querySelector('dialog[open]');
    if (open) open.addEventListener('close', () => window.setTimeout(check, 0), { once: true });
    else resolve();
  };
  check();
});

export const setUpStarPrompt = (
  controls: StarPromptControls,
  installed: () => Promise<boolean>,
  openRepository: () => void,
): (() => Promise<void>) => {
  let waiting = false;
  controls.star.addEventListener('click', () => openRepository());
  controls.dialog.addEventListener('close', () => {
    write(controls.dialog.returnValue === 'star' || read() !== '' ? 'done' : String(Date.now() + week));
  });
  // When a project has opened: asks if it is time, after a moment for its files to open.
  return async () => {
    if (waiting || !due() || !(await installed().catch(() => false))) return;
    waiting = true;
    try {
      await new Promise((resolve) => { window.setTimeout(resolve, 1500); });
      await noDialogOpen();
      if (!due() || controls.dialog.open) return;
      controls.dialog.returnValue = '';
      controls.dialog.showModal();
    } finally {
      waiting = false;
    }
  };
};
