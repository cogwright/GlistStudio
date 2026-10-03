// File icons from Seti, the icon font VS Code shows files with (MIT, see
// THIRD_PARTY_NOTICES.md). Glyphs and colors follow VS Code's Seti theme, except
// that headers get the C++ glyph, since Glist is C++, and a few types Seti leaves
// plain borrow a close glyph: CMake scripts, 3D models, and Apple's XML files.

export type FileIconColor = 'blue' | 'purple' | 'yellow' | 'green' | 'orange' | 'red' | 'pink' | 'grey' | 'git' | 'plain';

export interface FileIcon {
  glyph: string;
  color: FileIconColor;
}

const seti = {
  audio: { glyph: '\ue005', color: 'purple' },
  c: { glyph: '\ue00c', color: 'blue' },
  cmake: { glyph: '\ue05f', color: 'blue' },
  config: { glyph: '\ue019', color: 'grey' },
  cpp: { glyph: '\ue01a', color: 'blue' },
  css: { glyph: '\ue01d', color: 'blue' },
  csv: { glyph: '\ue01e', color: 'green' },
  database: { glyph: '\ue022', color: 'pink' },
  favicon: { glyph: '\ue02f', color: 'yellow' },
  font: { glyph: '\ue033', color: 'red' },
  git: { glyph: '\ue034', color: 'git' },
  gradle: { glyph: '\ue03c', color: 'blue' },
  header: { glyph: '\ue01a', color: 'purple' },
  html: { glyph: '\ue048', color: 'orange' },
  image: { glyph: '\ue04c', color: 'purple' },
  info: { glyph: '\ue04d', color: 'blue' },
  java: { glyph: '\ue050', color: 'red' },
  javascript: { glyph: '\ue051', color: 'yellow' },
  json: { glyph: '\ue055', color: 'yellow' },
  license: { glyph: '\ue05a', color: 'yellow' },
  lua: { glyph: '\ue05e', color: 'blue' },
  makefile: { glyph: '\ue05f', color: 'orange' },
  markdown: { glyph: '\ue060', color: 'blue' },
  model: { glyph: '\ue091', color: 'blue' },
  objectiveC: { glyph: '\ue00c', color: 'yellow' },
  objectiveCpp: { glyph: '\ue01a', color: 'yellow' },
  pdf: { glyph: '\ue06d', color: 'red' },
  plain: { glyph: '\ue023', color: 'plain' },
  powershell: { glyph: '\ue074', color: 'blue' },
  python: { glyph: '\ue07b', color: 'blue' },
  shell: { glyph: '\ue089', color: 'green' },
  svg: { glyph: '\ue091', color: 'purple' },
  swift: { glyph: '\ue092', color: 'orange' },
  typescript: { glyph: '\ue099', color: 'blue' },
  video: { glyph: '\ue09b', color: 'pink' },
  windows: { glyph: '\ue0a2', color: 'blue' },
  xml: { glyph: '\ue0a5', color: 'orange' },
  yaml: { glyph: '\ue0a7', color: 'purple' },
  zip: { glyph: '\ue0a9', color: 'grey' },
} satisfies Record<string, FileIcon>;

type SetiIcon = keyof typeof seti;

// Maps, so that names such as "constructor" do not find Object's properties.
const byName = new Map(Object.entries<SetiIcon>({
  'cmakelists.txt': 'cmake',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  'readme.md': 'info',
  makefile: 'makefile',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.clang-format': 'config',
  '.clang-tidy': 'config',
  '.clangd': 'config',
  '.editorconfig': 'config',
}));

const byExtension = new Map(Object.entries<SetiIcon>({
  c: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  h: 'header', hh: 'header', hpp: 'header', hxx: 'header', inl: 'header', ipp: 'header', tpp: 'header',
  m: 'objectiveC', mm: 'objectiveCpp',
  cmake: 'cmake',
  md: 'markdown', markdown: 'markdown',
  json: 'json', jsonc: 'json',
  xml: 'xml', plist: 'xml', storyboard: 'xml', xib: 'xml',
  yml: 'yaml', yaml: 'yaml',
  ini: 'config', cfg: 'config', conf: 'config', properties: 'config', prefs: 'config',
  sh: 'shell', bash: 'shell', zsh: 'shell', command: 'shell',
  bat: 'windows', cmd: 'windows', ps1: 'powershell',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', tga: 'image', tif: 'image', tiff: 'image',
  webp: 'image', hdr: 'image', exr: 'image', psd: 'image',
  ico: 'favicon', svg: 'svg',
  mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio', wma: 'audio', opus: 'audio',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video', wmv: 'video', m4v: 'video', ogv: 'video', mpeg: 'video',
  mpg: 'video',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  obj: 'model', mtl: 'model', fbx: 'model', dae: 'model', gltf: 'model', glb: 'model', '3ds': 'model', stl: 'model',
  ply: 'model',
  zip: 'zip', '7z': 'zip', rar: 'zip', tar: 'zip', gz: 'zip', xz: 'zip', jar: 'zip',
  csv: 'csv', db: 'database', sqlite: 'database', pdf: 'pdf',
  html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', ts: 'typescript',
  py: 'python', lua: 'lua', java: 'java', gradle: 'gradle', swift: 'swift',
}));

export const fileIcon = (fileName: string): FileIcon => {
  const name = fileName.toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  return seti[byName.get(name) ?? byExtension.get(extension) ?? 'plain'];
};

export const fileIconElement = (fileName: string): HTMLSpanElement => {
  const { glyph, color } = fileIcon(fileName);
  const element = document.createElement('span');
  element.className = `file-icon ${color}`;
  element.textContent = glyph;
  element.setAttribute('aria-hidden', 'true');
  return element;
};
