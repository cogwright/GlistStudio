import {
  AnimationMixer, Box3, BufferAttribute, BufferGeometry, DirectionalLight, GridHelper, HemisphereLight, LoadingManager, Material, Mesh,
  MeshStandardMaterial, Object3D, PerspectiveCamera, Points, PointsMaterial, Scene, Texture, Timer, Vector3, WebGLRenderer, type AnimationClip, type SkinnedMesh,
} from 'three';

// three.js's add-ons are ES modules only, which this CommonJS build can import only so.
/* eslint-disable import/no-unresolved */
const addOns = async () => {
  const [
    { OrbitControls }, { ColladaLoader }, { FBXLoader }, { GLTFLoader }, { MTLLoader }, { OBJLoader }, { PLYLoader }, { STLLoader }, { TDSLoader }, { TGALoader },
  ] = await Promise.all([
    import('three/examples/jsm/controls/OrbitControls.js'), import('three/examples/jsm/loaders/ColladaLoader.js'),
    import('three/examples/jsm/loaders/FBXLoader.js'), import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/MTLLoader.js'), import('three/examples/jsm/loaders/OBJLoader.js'),
    import('three/examples/jsm/loaders/PLYLoader.js'), import('three/examples/jsm/loaders/STLLoader.js'),
    import('three/examples/jsm/loaders/TDSLoader.js'), import('three/examples/jsm/loaders/TGALoader.js'),
  ]);
  return { OrbitControls, ColladaLoader, FBXLoader, GLTFLoader, MTLLoader, OBJLoader, PLYLoader, STLLoader, TDSLoader, TGALoader };
};
/* eslint-enable import/no-unresolved */
type AddOns = Awaited<ReturnType<typeof addOns>>;

// A 3D model drawn with three.js, for its tab (model-page.ts): turned with the
// mouse, drawn only when something changed, and every bit of it given back
// when the tab goes, since a page has only a few WebGL contexts.

export interface ModelFacts { meshes: number; triangles: number; vertices: number; materials: number; size: [number, number, number] }

export interface ModelScene {
  facts: ModelFacts;
  animations: string[];
  resetView(): void;
  setWireframe(on: boolean): void;
  setGrid(on: boolean): void;
  // Plays an animation over and over, or none.
  play(index: number | null): void;
  dispose(): void;
}

const bytesOf = (base64: string): Uint8Array => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
const textOf = (base64: string): string => new TextDecoder().decode(bytesOf(base64));
const bufferOf = (base64: string): ArrayBuffer => bytesOf(base64).buffer as ArrayBuffer;
const mimeTypes: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
};
const baseName = (name: string): string => name.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';

// One white pixel, for a picture the model names but does not have: its
// material keeps its own colour instead of being drawn black.
const whitePixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

// The model's files as blob: URLs, for the names loaders ask for: as written,
// URL-decoded, or by the file's name alone.
const fileUrls = (files: Record<string, string>): { find(url: string): string | undefined; revoke(): void } => {
  const urls = new Map<string, string>();
  const blank = URL.createObjectURL(new Blob([bytesOf(whitePixel) as BlobPart], { type: 'image/png' }));
  const made: string[] = [blank];
  Object.entries(files).forEach(([name, data]) => {
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    const url = URL.createObjectURL(new Blob([bytesOf(data) as BlobPart], { type: mimeTypes[extension] ?? 'application/octet-stream' }));
    made.push(url);
    const written = name.replace(/\\/g, '/').replace(/^\.\//, '');
    [written, written.toLowerCase(), baseName(written)].forEach((key) => { if (!urls.has(key)) urls.set(key, url); });
  });
  const decoded = (url: string): string => { try { return decodeURIComponent(url); } catch { return url; } };
  return {
    find: (url) => {
      if (/^(blob|data):/.test(url)) return undefined;
      const written = decoded(url).replace(/\\/g, '/').replace(/^\.\//, '');
      return urls.get(written) ?? urls.get(written.toLowerCase()) ?? urls.get(baseName(written))
        ?? (/\.(png|jpe?g|gif|bmp|webp)$/i.test(written) ? blank : undefined);
    },
    revoke: () => made.forEach((url) => URL.revokeObjectURL(url)),
  };
};

// A surface for formats that bring only shape: STL, and PLY.
const shaded = (geometry: BufferGeometry): Object3D => {
  const colored = Boolean(geometry.getAttribute('color'));
  if (!geometry.index && !geometry.getAttribute('normal') && geometry.getAttribute('position').count % 3 !== 0) {
    return new Points(geometry, new PointsMaterial({ size: 0.01, vertexColors: colored, sizeAttenuation: true }));
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  return new Mesh(geometry, new MeshStandardMaterial({ color: colored ? 0xffffff : 0xb8bcc6, vertexColors: colored, roughness: 0.7, metalness: 0.05 }));
};

const load = async (
  model: GlistModelFile, manager: LoadingManager,
  { ColladaLoader, FBXLoader, GLTFLoader, MTLLoader, OBJLoader, PLYLoader, STLLoader, TDSLoader }: AddOns,
): Promise<{ object: Object3D; clips: AnimationClip[] }> => {
  switch (model.format) {
    case 'gltf':
    case 'glb': {
      const gltf = await new GLTFLoader(manager).parseAsync(model.format === 'gltf' ? textOf(model.data) : bufferOf(model.data), '');
      return { object: gltf.scene, clips: gltf.animations };
    }
    case 'obj': {
      const objects = new OBJLoader(manager);
      const library = /^\s*mtllib\s+(.+?)\s*$/m.exec(textOf(model.data))?.[1];
      const materialFile = library && Object.keys(model.files).find((name) => name === library || library.split(/\s+/).includes(name));
      if (materialFile) {
        const materials = new MTLLoader(manager).parse(textOf(model.files[materialFile]), '');
        materials.preload();
        objects.setMaterials(materials);
      }
      return { object: objects.parse(textOf(model.data)), clips: [] };
    }
    case 'fbx': {
      const group = new FBXLoader(manager).parse(bufferOf(model.data), '');
      return { object: group, clips: group.animations };
    }
    case 'dae': {
      const collada = new ColladaLoader(manager).parse(fannedCollada(textOf(model.data)), '');
      if (!collada) throw new Error('Collada');
      return { object: collada.scene, clips: collada.scene.animations };
    }
    case '3ds':
      return { object: new TDSLoader(manager).parse(bufferOf(model.data), ''), clips: [] };
    case 'stl':
      return { object: shaded(new STLLoader().parse(bufferOf(model.data))), clips: [] };
    case 'ply':
      return { object: shaded(new PLYLoader().parse(bufferOf(model.data))), clips: [] };
    default:
      throw new Error(model.format);
  }
};

// three.js's Collada loader cuts a polygon of more than four corners into
// triangles once for each of its inputs, taking each input's values for
// positions, so normals, texture coordinates and bone weights no longer line
// up with the positions (Glist Engine's astroBoy sample has such polygons).
// Those polygons are cut into fans here first, the same way for every input.
const fannedCollada = (text: string): string => {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  let changed = false;
  xml.querySelectorAll('polylist').forEach((list) => {
    const countsNode = list.querySelector(':scope > vcount');
    const indicesNode = list.querySelector(':scope > p');
    const counts = (countsNode?.textContent ?? '').trim().split(/\s+/).map(Number);
    if (!countsNode || !indicesNode || !counts.some((count) => count > 4)) return;
    const stride = Math.max(0, ...[...list.querySelectorAll(':scope > input')].map((input) => Number(input.getAttribute('offset')))) + 1;
    const indices = (indicesNode.textContent ?? '').trim().split(/\s+/);
    const nextCounts: number[] = [];
    const nextIndices: string[] = [];
    let first = 0;
    counts.forEach((count) => {
      const corner = (k: number): string[] => indices.slice((first + k) * stride, (first + k + 1) * stride);
      if (count > 4) {
        for (let k = 1; k < count - 1; k++) { nextCounts.push(3); nextIndices.push(...corner(0), ...corner(k), ...corner(k + 1)); }
      } else {
        nextCounts.push(count);
        for (let k = 0; k < count; k++) nextIndices.push(...corner(k));
      }
      first += count;
    });
    countsNode.textContent = nextCounts.join(' ');
    indicesNode.textContent = nextIndices.join(' ');
    list.setAttribute('count', String(nextCounts.length));
    changed = true;
  });
  return changed ? new XMLSerializer().serializeToString(xml) : text;
};

// A skinned mesh with fewer bone weights than vertices, which three.js would
// read past the end of and stop drawing on: the vertices without any move with
// the root bone.
const mendSkins = (object: Object3D): void => {
  object.traverse((child) => {
    const skinned = child as SkinnedMesh;
    if (!skinned.isSkinnedMesh) return;
    const { count } = skinned.geometry.getAttribute('position');
    (['skinIndex', 'skinWeight'] as const).forEach((name) => {
      const given = skinned.geometry.getAttribute(name);
      if (!given || given.count >= count) return;
      const padded = new Float32Array(count * 4);
      for (let vertex = 0; vertex < count; vertex++) {
        for (let k = 0; k < 4; k++) {
          padded[vertex * 4 + k] = vertex < given.count ? given.getComponent(vertex, k) : Number(name === 'skinWeight' && k === 0);
        }
      }
      skinned.geometry.setAttribute(name, new BufferAttribute(padded, 4));
    });
  });
};

const materialsOf = (object: Object3D): Material[] => {
  const found = new Set<Material>();
  object.traverse((child) => {
    const { material } = child as Mesh;
    (Array.isArray(material) ? material : material ? [material] : []).forEach((each) => found.add(each));
  });
  return [...found];
};

const factsOf = (object: Object3D, box: Box3): ModelFacts => {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  object.traverse((child) => {
    const { geometry } = child as Mesh;
    const positions = geometry?.getAttribute('position')?.count ?? 0;
    // A point cloud has points only.
    if ((child as Points).isPoints) vertices += positions;
    if (!(child as Mesh).isMesh || !geometry) return;
    meshes += 1;
    vertices += positions;
    triangles += Math.floor((geometry.index?.count ?? positions) / 3);
  });
  const size = box.getSize(new Vector3());
  return { meshes, triangles, vertices, materials: materialsOf(object).length, size: [size.x, size.y, size.z] };
};

export const showModel = async (host: HTMLElement, model: GlistModelFile): Promise<ModelScene> => {
  const loaders = await addOns();
  const { OrbitControls, TGALoader } = loaders;
  const urls = fileUrls(model.files);
  const manager = new LoadingManager();
  manager.setURLModifier((url) => urls.find(url) ?? url);
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true });
  } catch (error) {
    urls.revoke();
    // Said as such by the tab: a computer without WebGL cannot draw a model.
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { webgl: true });
  }
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  // The light comes from where one looks from, so no side of the model is left dark.
  const light = new DirectionalLight(0xffffff, 2.2);
  light.position.set(0.5, 1, 1);
  camera.add(light);
  scene.add(camera, new HemisphereLight(0xffffff, 0x50525a, 1.6));
  let frame = 0;
  let mixer: AnimationMixer | null = null;
  const timer = new Timer();
  const draw = (): void => renderer.render(scene, camera);
  // An animation plays on while its tab is behind another, unseen and undrawn.
  const loop = (): void => {
    frame = requestAnimationFrame(loop);
    timer.update();
    const delta = timer.getDelta();
    if (host.offsetParent === null) return;
    mixer?.update(delta);
    draw();
  };
  // Textures arrive after the model; each one draws it again.
  manager.onLoad = draw;
  manager.onProgress = draw;
  const loaded = await load(model, manager, loaders).catch((error: unknown) => {
    renderer.dispose();
    renderer.forceContextLoss();
    urls.revoke();
    throw error;
  });
  const { object, clips } = loaded;
  mendSkins(object);
  scene.add(object);
  // Measured as posed: a skinned mesh's size comes from where its bones are.
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object);
  const center = box.getCenter(new Vector3());
  const span = Math.max(...box.getSize(new Vector3()).toArray(), 1e-3);
  const grid = new GridHelper(span * 4, 20, 0x8a8f99, 0x5a5e66);
  grid.position.set(center.x, box.min.y, center.z);
  grid.renderOrder = -1;
  (grid.material as Material).transparent = true;
  (grid.material as Material).opacity = 0.35;
  scene.add(grid);
  camera.near = span / 1000;
  camera.far = span * 100;
  const resetView = (): void => {
    const distance = span / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.6;
    camera.position.copy(center).add(new Vector3(0.6, 0.45, 1).normalize().multiplyScalar(distance));
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    draw();
  };
  const resize = (): void => {
    const { clientWidth: width, clientHeight: height } = host;
    if (!width || !height) return;
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    draw();
  };
  const resizes = new ResizeObserver(resize);
  renderer.domElement.className = 'model-canvas';
  host.append(renderer.domElement);
  resizes.observe(host);
  controls.addEventListener('change', draw);
  resize();
  resetView();
  return {
    facts: factsOf(object, box),
    animations: clips.map((clip, index) => clip.name || `#${index + 1}`),
    resetView,
    setWireframe: (on) => {
      materialsOf(object).forEach((material) => { if ('wireframe' in material) (material as MeshStandardMaterial).wireframe = on; });
      draw();
    },
    setGrid: (on) => { grid.visible = on; draw(); },
    play: (index) => {
      cancelAnimationFrame(frame);
      mixer?.stopAllAction();
      mixer = null;
      if (index !== null && clips[index]) {
        mixer = new AnimationMixer(object);
        mixer.clipAction(clips[index]).play();
        timer.update();
        loop();
      } else draw();
    },
    dispose: () => {
      cancelAnimationFrame(frame);
      mixer?.stopAllAction();
      resizes.disconnect();
      controls.dispose();
      scene.traverse((child) => {
        (child as Mesh).geometry?.dispose();
      });
      materialsOf(scene).forEach((material) => {
        Object.values(material).forEach((value) => { if (value instanceof Texture) value.dispose(); });
        material.dispose();
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      urls.revoke();
    },
  };
};
