// Files shown as 3D models rather than as text, by their extension: the formats
// Glist Engine's models load from (through Assimp) that three.js reads too.
const formats: Record<string, GlistModelFormat> = {
  gltf: 'gltf', glb: 'glb', obj: 'obj', fbx: 'fbx', dae: 'dae', stl: 'stl', ply: 'ply', '3ds': '3ds',
};

export const modelType = (filePath: string): GlistModelFormat | null =>
  formats[/\.([^./\\]+)$/.exec(filePath)?.[1]?.toLowerCase() ?? ''] ?? null;
