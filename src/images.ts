// Files shown as pictures rather than as text, by their extension, with the
// type a browser takes them as. Engines' formats such as .tga and .dds are not
// among them: a browser cannot draw those.
const types: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
};

export const imageType = (filePath: string): string | null =>
  types[/\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase() ?? ''] ?? null;
