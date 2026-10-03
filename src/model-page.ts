import { getLanguage, t } from './localization';
import type { ModelFacts, ModelScene } from './model-scene';

// A 3D model in a tab of its own: drawn with three.js, which loads only once a
// model is opened (model-scene.ts), with buttons to look at it again from the
// front, as a wireframe, without the floor grid, or moving in one of its
// animations, and what it is made of beneath.

export interface ModelPage {
  name: string;
  model?: GlistModelFile;
  error?: string;
}

const bytes = (size: number): string => {
  const [unit, value] = size >= 1024 * 1024 ? ['megabyte', size / 1024 / 1024] : size >= 1024 ? ['kilobyte', size / 1024] : ['byte', size];
  return new Intl.NumberFormat(getLanguage(), { style: 'unit', unit, maximumFractionDigits: 1 }).format(value as number);
};

const describe = (format: GlistModelFormat, facts: ModelFacts, size: number): string => {
  const number = new Intl.NumberFormat(getLanguage(), { maximumFractionDigits: 2 });
  return [
    format.toUpperCase(),
    `${t('modelMeshes')} ${number.format(facts.meshes)}`,
    `${t('modelTriangles')} ${number.format(facts.triangles)}`,
    `${t('modelVertices')} ${number.format(facts.vertices)}`,
    `${t('modelMaterials')} ${number.format(facts.materials)}`,
    facts.size.map((side) => number.format(side)).join(' × '),
    bytes(size),
  ].join(' · ');
};

const button = (label: string, pressed?: boolean): HTMLButtonElement => {
  const made = document.createElement('button');
  made.type = 'button';
  made.className = 'readme-github model-tool';
  made.textContent = label;
  if (pressed !== undefined) made.setAttribute('aria-pressed', String(pressed));
  return made;
};

export const renderModelPage = (target: HTMLElement, page: ModelPage): { dispose(): void } => {
  const failed = (detail?: string): void => {
    const paragraph = document.createElement('p');
    paragraph.className = 'readme-status';
    paragraph.textContent = detail ? `${t('modelFailed')}: ${detail}` : t('modelFailed');
    target.replaceChildren(paragraph);
  };
  if (page.error) { failed(page.error); return { dispose: (): undefined => undefined }; }
  const { model } = page;
  const facts = document.createElement('div');
  facts.className = 'image-facts model-facts';
  facts.textContent = t('modelLoading');
  // Said as soon as the tab opens, while the file is still being read.
  if (!model) { target.replaceChildren(facts); return { dispose: (): undefined => undefined }; }
  let scene: ModelScene | null = null;
  let disposed = false;
  const stage = document.createElement('div');
  stage.className = 'model-stage';
  const hint = document.createElement('div');
  hint.className = 'model-hint';
  hint.textContent = t('modelHint');
  const tools = document.createElement('div');
  tools.className = 'model-tools';
  tools.hidden = true;
  const front = button(t('modelResetView'));
  const wireframe = button(t('modelWireframe'), false);
  const grid = button(t('modelGrid'), true);
  const animation = document.createElement('select');
  animation.className = 'agent-select model-animation';
  animation.setAttribute('aria-label', t('modelAnimation'));
  animation.hidden = true;
  tools.append(animation, front, wireframe, grid);
  const toggle = (made: HTMLButtonElement, apply: (on: boolean) => void): void => {
    made.addEventListener('click', () => {
      const on = made.getAttribute('aria-pressed') !== 'true';
      made.setAttribute('aria-pressed', String(on));
      apply(on);
    });
  };
  front.addEventListener('click', () => scene?.resetView());
  toggle(wireframe, (on) => scene?.setWireframe(on));
  toggle(grid, (on) => scene?.setGrid(on));
  animation.addEventListener('change', () => scene?.play(animation.value === '' ? null : Number(animation.value)));
  const parts: HTMLElement[] = [stage, hint, tools, facts];
  // What it names but could not be read, such as a texture not beside it.
  if (model.missing.length) {
    const missing = document.createElement('div');
    missing.className = 'model-missing';
    missing.textContent = `${t('modelMissing')}: ${model.missing.join(', ')}`;
    missing.title = model.missing.join('\n');
    parts.push(missing);
  }
  target.replaceChildren(...parts);
  // eslint-disable-next-line import/no-unresolved
  import('./model-scene.js').then(({ showModel }) => showModel(stage, model)).then((shown) => {
    if (disposed) { shown.dispose(); return; }
    scene = shown;
    facts.textContent = describe(model.format, shown.facts, model.size);
    tools.hidden = false;
    if (shown.animations.length) {
      animation.replaceChildren(new Option(t('modelNoAnimation'), ''), ...shown.animations.map((name, index) => new Option(name, String(index))));
      animation.hidden = false;
    }
  }).catch((error: Error & { webgl?: boolean }) => {
    if (!disposed) failed(error.webgl ? t('modelNoWebgl') : error.message);
  });
  return {
    dispose: () => {
      disposed = true;
      scene?.dispose();
      scene = null;
    },
  };
};
