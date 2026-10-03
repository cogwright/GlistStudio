import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gatherModel, namedFiles } from '../src/model-files.ts';

// What a model names: a glTF's buffers and images, an OBJ's materials, an MTL's
// textures after their options, a Collada file's images but not image ids, and
// picture names inside a binary file.
assert.deepEqual(namedFiles('a.gltf', Buffer.from(JSON.stringify({
  buffers: [{ uri: 'cube%20data.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }],
  images: [{ uri: 'textures/wood.png' }],
}))), ['cube data.bin', 'textures/wood.png']);
assert.deepEqual(namedFiles('a.obj', Buffer.from('# x\nmtllib My Model.mtl\nv 0 0 0\n')), ['My Model.mtl', 'My', 'Model.mtl']);
assert.deepEqual(namedFiles('a.mtl', Buffer.from('newmtl m\nmap_Kd -s 1 1 1 tex.png\nbump normal.png\n')), ['-s 1 1 1 tex.png', 'tex.png', 'normal.png']);
assert.deepEqual(namedFiles('a.dae', Buffer.from('<init_from>./boy_10.tga</init_from><init_from>file9</init_from><init_from>file:///C:/art/skin%20a.png</init_from>')),
  ['./boy_10.tga', 'C:/art/skin a.png']);
assert.deepEqual(namedFiles('a.fbx', Buffer.from('\x00\x1dC:\\Users\\artist\\wood.png\x00\x00\x08..\\tex\\metal.JPG\x00')), ['C:\\Users\\artist\\wood.png', '..\\tex\\metal.JPG']);

// Gathering: each file under the name the model gives it, materials followed to
// their textures, found by name in a textures folder, and nothing outside what
// may be read; what is not there, or not allowed, is said to be missing.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'glist-models-')));
const project = path.join(root, 'project');
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
try {
  write(path.join(project, 'models', 'tree.obj'), 'mtllib tree.mtl\nmtllib secret.mtl\nmtllib gone.mtl\nv 0 0 0\n');
  write(path.join(project, 'models', 'tree.mtl'), 'newmtl leaf\nmap_Kd -o 0 0 leaf.png\nmap_Bump C:\\art\\bark.png\n');
  write(path.join(project, 'models', 'leaf.png'), 'leaf');
  write(path.join(project, 'models', 'textures', 'bark.png'), 'bark');
  write(path.join(root, 'outside', 'secret.mtl'), 'secret');
  write(path.join(project, 'models', 'secret.mtl'), 'map_Kd ../../outside/secret.png\n');
  write(path.join(root, 'outside', 'secret.png'), 'secret');
  const readable = async (file) => {
    const real = realpathSync(file);
    if (!real.startsWith(`${project}${path.sep}`)) throw new Error('outside');
    return real;
  };
  const gathered = await gatherModel(path.join(project, 'models', 'tree.obj'), readable);
  assert.deepEqual(Object.keys(gathered.files).sort(), ['C:/art/bark.png', 'leaf.png', 'secret.mtl', 'tree.mtl']);
  assert.equal(Buffer.from(gathered.files['C:/art/bark.png'], 'base64').toString(), 'bark');
  assert.deepEqual(gathered.missing.sort(), ['../../outside/secret.png', 'gone.mtl']);
  assert.equal(Buffer.from(gathered.data, 'base64').toString().split('\n')[0], 'mtllib tree.mtl');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('Model file tests passed.');
