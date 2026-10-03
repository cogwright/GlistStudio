import { promises as fs } from 'node:fs';
import path from 'node:path';

// A 3D model and the files it names beside it, for its tab (model-page.ts):
// a glTF's buffers and pictures, an OBJ's materials and their textures, a
// Collada file's images, and for the binary formats (FBX, 3DS, GLB) anything
// in them that reads as a picture's file name. The tab cannot ask for them one
// by one while the model is drawn, so they are gathered here at once.

const pictures = 'png|jpe?g|tga|bmp|gif|webp|dds|tiff?|ktx2?';
// Where textures usually are, when a model names one by a path from elsewhere.
const textureFolders = ['', 'textures', 'Textures', 'texture', 'tex', 'images', path.join('..', 'textures'), path.join('..', 'Textures')];
// All of it crosses to the window in base64, through the main process.
const keptFiles = 64;
const keptBytes = 100 * 1024 * 1024;
export const modelBytes = 50 * 1024 * 1024;

const unique = (names: string[]): string[] => [...new Set(names.map((name) => name.trim()).filter(Boolean))];
const decoded = (name: string): string => { try { return decodeURIComponent(name); } catch { return name; } };

// What a file names, as it writes it.
export const namedFiles = (fileName: string, content: Buffer): string[] => {
  const extension = path.extname(fileName).toLowerCase();
  const text = content.toString('latin1');
  if (extension === '.gltf') {
    try {
      const json = JSON.parse(content.toString('utf8')) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
      return unique([...(json.buffers ?? []), ...(json.images ?? [])]
        .map((entry) => entry.uri ?? '').filter((uri) => uri && !uri.startsWith('data:')).map(decoded));
    } catch { return []; }
  }
  if (extension === '.obj') {
    // mtllib may list several, or one whose name has spaces.
    return unique([...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].flatMap(([, names]) => [names, ...names.split(/\s+/)]));
  }
  if (extension === '.mtl') {
    // The file name comes last, after options such as -s 1 1 1.
    return unique([...text.matchAll(/^\s*(?:map_\w+|bump|disp|decal|refl|norm)\s+(.+?)\s*$/gim)]
      .flatMap(([, rest]) => [rest, rest.split(/\s+/).pop() ?? '']));
  }
  if (extension === '.dae') {
    // Also an image's id, such as file9, where a surface names its image.
    return unique([...text.matchAll(/<init_from>\s*([^<]+?)\s*<\/init_from>/g)].map(([, name]) => decoded(name.replace(/^file:\/\/\/?/, '')))
      .filter((name) => /\.\w{2,4}$/.test(name)));
  }
  // FBX, 3DS and GLB: strings in them that end as a picture's name does.
  return unique([...text.matchAll(new RegExp(`[\\x20-\\x7e]{1,240}?\\.(?:${pictures})(?![\\w])`, 'gi'))]
    .map(([name]) => name.replace(/^[^\w./\\:~-]+/, '')));
};

// Where a named file is: as named from the model's folder, or by its name alone
// in the folder or one textures are kept in.
const findNamed = async (folder: string, name: string): Promise<string | null> => {
  const written = name.replace(/\\/g, '/');
  const base = path.basename(written);
  const candidates = [
    path.resolve(folder, written),
    ...textureFolders.map((textures) => path.resolve(folder, textures, base)),
  ];
  for (const candidate of candidates) {
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Not there. */ }
  }
  return null;
};

export interface GatheredModel {
  data: string;
  size: number;
  files: Record<string, string>;
  missing: string[];
}

// The model in base64, with each file it names under the name it gave, read
// only where readable() allows. Materials are followed to their textures.
export const gatherModel = async (modelPath: string, readable: (filePath: string) => Promise<string>): Promise<GatheredModel> => {
  const model = await fs.readFile(modelPath);
  const folder = path.dirname(modelPath);
  const files: Record<string, string> = {};
  const missing: string[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();
  let bytes = model.length;
  const queue = namedFiles(modelPath, model).map((name) => ({ name, from: folder }));
  while (queue.length) {
    const { name, from } = queue.shift();
    const key = name.replace(/\\/g, '/');
    if (key in files || seen.has(`${from}\n${name}`)) continue;
    seen.add(`${from}\n${name}`);
    const found = await findNamed(from, name) ?? (from === folder ? null : await findNamed(folder, name));
    if (!found) { notFound.push(name); continue; }
    let safe: string;
    try { safe = await readable(found); } catch { missing.push(name); continue; }
    const size = (await fs.stat(safe)).size;
    if (Object.keys(files).length >= keptFiles || bytes + size > keptBytes) { missing.push(name); continue; }
    const content = await fs.readFile(safe);
    bytes += size;
    files[key] = content.toString('base64');
    if (path.extname(safe).toLowerCase() === '.mtl') {
      queue.push(...namedFiles(safe, content).map((named) => ({ name: named, from: path.dirname(safe) })));
    }
  }
  // A line read whole and word by word (an OBJ's mtllib, an MTL's options), and
  // an absolute path beside the relative one (FBX): only what was not found
  // under any of its readings is missing.
  const foundNames = Object.keys(files);
  const baseName = (name: string): string => path.basename(name.replace(/\\/g, '/')).toLowerCase();
  const gone = notFound.filter((name) => {
    const words = name.split(/\s+/);
    if (words.length > 1 && (words.some((word) => word.replace(/\\/g, '/') in files) || notFound.includes(words[words.length - 1]))) return false;
    if (foundNames.some((known) => known.split(/\s+/).includes(name))) return false;
    return !foundNames.some((known) => baseName(known) === baseName(name));
  });
  return { data: model.toString('base64'), size: model.length, files, missing: unique([...missing, ...gone]) };
};
