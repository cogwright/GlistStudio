import { getLanguage, t } from './localization';

// An image file in a tab of its own: fitted to the tab, or at its own size after
// a click, on a checkerboard where it is see-through, with its size beneath.

export interface ImagePage {
  name: string;
  image?: GlistImageFile;
  error?: string;
}

const bytes = (size: number): string => {
  const [unit, value] = size >= 1024 * 1024 ? ['megabyte', size / 1024 / 1024] : size >= 1024 ? ['kilobyte', size / 1024] : ['byte', size];
  return new Intl.NumberFormat(getLanguage(), { style: 'unit', unit, maximumFractionDigits: 1 }).format(value as number);
};

export const renderImagePage = (target: HTMLElement, page: ImagePage): { dispose(): void } => {
  const done = { dispose: (): void => undefined };
  const failed = (detail?: string): void => {
    const paragraph = document.createElement('p');
    paragraph.className = 'readme-status';
    paragraph.textContent = detail ? `${t('imageFailed')}: ${detail}` : t('imageFailed');
    target.replaceChildren(paragraph);
  };
  if (page.error) { failed(page.error); return done; }
  const { image } = page;
  if (!image) { target.replaceChildren(); return done; }
  const stage = document.createElement('div');
  stage.className = 'image-stage';
  const picture = document.createElement('img');
  picture.className = 'image-picture';
  picture.alt = page.name;
  const facts = document.createElement('div');
  facts.className = 'image-facts';
  facts.textContent = bytes(image.size);
  // An SVG without its own size has none to tell.
  picture.addEventListener('load', () => {
    if (picture.naturalWidth > 0) facts.textContent = `${picture.naturalWidth} × ${picture.naturalHeight} · ${bytes(image.size)}`;
  });
  picture.addEventListener('error', () => failed());
  picture.addEventListener('click', () => stage.classList.toggle('actual'));
  picture.src = `data:${image.type};base64,${image.data}`;
  stage.append(picture);
  target.replaceChildren(stage, facts);
  return done;
};
