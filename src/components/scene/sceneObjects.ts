import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneModel } from 'three/addons/utils/SkeletonUtils.js';
import type { SceneConfig, SceneObject } from '../../lib/scene';
import type { SurfaceKey } from '../../lib/types';
import { FrameVideoTexture } from './FrameVideoTexture.ts';

const modelBuffers = new Map<string, ArrayBuffer>();
let modelBufferBytes = 0;

async function modelBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const cached = modelBuffers.get(url);
  if (cached) return cached;
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('Не удалось загрузить модель');
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 50 * 1024 * 1024) throw new Error('Модель превышает 50 МБ');
  while (modelBuffers.size && modelBufferBytes + buffer.byteLength > 80 * 1024 * 1024) {
    const key = modelBuffers.keys().next().value as string; modelBufferBytes -= modelBuffers.get(key)!.byteLength; modelBuffers.delete(key);
  }
  modelBuffers.set(url, buffer); modelBufferBytes += buffer.byteLength;
  return buffer;
}

function disposeObjects(groups: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  for (const group of groups) group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if ((object as THREE.InstancedMesh).isInstancedMesh) (object as THREE.InstancedMesh).dispose();
    if (mesh.geometry) geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of list) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

export function disposeObject(group: THREE.Object3D) { disposeObjects([group]); }

export function applySceneTransform(group: THREE.Object3D, object: SceneObject) {
  group.position.set(...object.position);
  group.rotation.set(...object.rotation.map(THREE.MathUtils.degToRad) as [number, number, number]);
  group.scale.set(...object.size);
}

export function createSceneContent(config: SceneConfig, options: {
  videos?: Partial<Record<SurfaceKey, HTMLVideoElement>>;
  editor?: boolean;
  onError?: (message: string) => void;
  onLoad?: () => void;
  onVideoFrame?: () => void;
} = {}) {
  const group = new THREE.Group();
  const objects = new Map<string, THREE.Group>();
  const abort = new AbortController();
  const pendingModels = new Map<string, Promise<THREE.Group>>();
  const parsedModels = new Map<string, THREE.Group>();
  let disposed = false;
  const videoTextures = new Map<SurfaceKey, THREE.VideoTexture>();
  let chairGeometry: THREE.BufferGeometry | null = null;
  const chairInstances = new Map<string, THREE.Group[]>();
  const getChairGeometry = () => {
    if (chairGeometry) return chairGeometry;
    const parts: THREE.BufferGeometry[] = [];
    const addPart = (size: [number, number, number], position: [number, number, number]) => {
      parts.push(new THREE.BoxGeometry(...size).translate(...position));
    };
    addPart([1, .10, 1], [0, .5, 0]);
    addPart([1, .45, .10], [0, .775, -.45]);
    for (const x of [-.40, .40]) for (const z of [-.40, .40]) addPart([.09, .45, .09], [x, .225, z]);
    chairGeometry = mergeGeometries(parts, false);
    parts.forEach((part) => part.dispose());
    if (!chairGeometry) throw new Error('Не удалось создать геометрию стула');
    return chairGeometry;
  };
  const sourceMaterial = (source: SurfaceKey | null, color: string, room = false) => {
    const video = source && options.videos?.[source];
    if (video && source) {
      let texture = videoTextures.get(source);
      if (!texture) {
        texture = new FrameVideoTexture(video, options.onVideoFrame);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = false;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        videoTextures.set(source, texture);
      }
      return new THREE.MeshBasicMaterial({ map: texture, side: room ? THREE.FrontSide : THREE.DoubleSide, toneMapped: false });
    }
    return new THREE.MeshBasicMaterial({
      color, side: room ? THREE.FrontSide : THREE.DoubleSide, toneMapped: false,
      transparent: Boolean(options.editor && room), opacity: options.editor && room ? .16 : 1,
      depthWrite: !(options.editor && room),
    });
  };
  const { width: w, depth: d, height: h } = config.room;
  if (config.showRoomSurfaces) {
    const walls: Array<{ source: SurfaceKey; width: number; height: number; pos: [number, number, number]; rotation: number }> = [
      { source: 'right', width: w, height: h, pos: [0, h / 2, -d / 2], rotation: 0 },
      { source: 'back', width: d, height: h, pos: [w / 2, h / 2, 0], rotation: -Math.PI / 2 },
      { source: 'left', width: w, height: h, pos: [0, h / 2, d / 2], rotation: Math.PI },
      { source: 'center', width: d, height: h, pos: [-w / 2, h / 2, 0], rotation: Math.PI / 2 },
    ];
    for (const wall of walls) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wall.width, wall.height), sourceMaterial(wall.source, '#4b5263', true));
      mesh.position.set(...wall.pos); mesh.rotation.y = wall.rotation; group.add(mesh);
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), sourceMaterial('floor', '#252a35', true));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -.015; group.add(floor);
  }
  const box = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: options.editor ? 0x5f697e : 0x3e4250 }));
  box.dispose(); edges.position.y = h / 2; group.add(edges);

  function addBox(parent: THREE.Group, material: THREE.Material, size: [number, number, number], position: [number, number, number]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  for (const object of config.objects) {
    const root = new THREE.Group(); root.userData.sceneId = object.id;
    objects.set(object.id, root); group.add(root);
    if (object.type === 'chair' && !options.editor) {
      applySceneTransform(root, object);
      root.updateMatrix();
      const instances = chairInstances.get(object.color) || [];
      instances.push(root); chairInstances.set(object.color, instances);
      continue;
    }
    const material = new THREE.MeshStandardMaterial({ color: object.color, roughness: .76, metalness: .05 });
    if (object.type === 'screen') {
      // Full-height thin screens fitted to the perimeter behave as projection
      // walls: looking from outside exposes the hall instead of opaque backs.
      const boundary = object.size[2] <= .1 && Math.abs(object.size[1] - h) < .2 && Math.abs(object.position[1]) < .1 && (
        (Math.abs(Math.abs(object.position[0]) - w / 2) < .15 && Math.abs(object.size[0] - d) < .2) ||
        (Math.abs(Math.abs(object.position[2]) - d / 2) < .15 && Math.abs(object.size[0] - w) < .2)
      );
      if (boundary) material.dispose();
      else addBox(root, material, [1, 1, 1], [0, .5, 0]);
      const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sourceMaterial(object.source, object.color, boundary));
      front.position.set(0, .5, boundary ? 0 : .505); root.add(front);
    } else if (object.type === 'floor') {
      if (object.source) {
        // BoxGeometry's +Y face has the same UV orientation as the previous
        // horizontal video plane. Put the video on that face itself: a second
        // plane only .005 * thickness above it caused depth fighting on thin
        // floors, especially when viewed at a shallow angle.
        const top = sourceMaterial(object.source, object.color);
        const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [material, material, top, material, material, material]);
        floor.position.y = .5; root.add(floor);
      } else addBox(root, material, [1, 1, 1], [0, .5, 0]);
    } else if (object.type === 'table') {
      addBox(root, material, [1, .10, 1], [0, .95, 0]);
      for (const x of [-.42, .42]) for (const z of [-.40, .40]) addBox(root, material, [.08, .9, .09], [x, .45, z]);
    } else if (object.type === 'chair') {
      // Keep separate selectable objects in the editor, sharing one geometry.
      root.add(new THREE.Mesh(getChairGeometry(), material));
    } else if (object.type === 'model') {
      const asset = config.assets.find((item) => item.id === object.assetId);
      const placeholder = addBox(root, new THREE.MeshBasicMaterial({ color: '#5a6380', wireframe: true }), [1, 1, 1], [0, .5, 0]);
      material.dispose();
      if (!asset) options.onError?.(`Не найден файл модели «${object.name}»`);
      else {
        let modelPromise = pendingModels.get(asset.url);
        if (!modelPromise) {
          const manager = new THREE.LoadingManager();
          manager.setURLModifier((url) => {
            if (url.startsWith('blob:') || url.startsWith('data:')) return url;
            throw new Error('Модель должна содержать текстуры и геометрию внутри GLB');
          });
          const loader = new GLTFLoader(manager);
          modelPromise = modelBuffer(asset.url, abort.signal).then((buffer) => loader.parseAsync(buffer, '')).then((gltf) => {
            if (disposed) { disposeObject(gltf.scene); throw new DOMException('Сцена закрыта', 'AbortError'); }
            parsedModels.set(asset.url, gltf.scene);
            return gltf.scene;
          });
          pendingModels.set(asset.url, modelPromise);
        }
        modelPromise.then((source) => {
          if (disposed) return;
          // Each object retains independent nodes/bones and editor selection,
          // while repeated furniture shares the parsed geometry and textures.
          const instance = cloneModel(source);
          const bounds = new THREE.Box3().setFromObject(instance);
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          if (bounds.isEmpty() || ![size.x, size.y, size.z].every(Number.isFinite)) throw new Error('В модели нет видимой геометрии');
          const normalizer = new THREE.Group();
          normalizer.scale.set(1 / Math.max(size.x, .001), 1 / Math.max(size.y, .001), 1 / Math.max(size.z, .001));
          instance.position.sub(new THREE.Vector3(center.x, bounds.min.y, center.z));
          normalizer.add(instance); root.remove(placeholder); disposeObject(placeholder); root.add(normalizer);
          root.traverse((node) => { node.userData.sceneId = object.id; });
          options.onLoad?.();
        }).catch((error) => { if (!disposed && error.name !== 'AbortError') options.onError?.(`${object.name}: ${error.message}`); });
      }
    } else addBox(root, material, [1, 1, 1], [0, .5, 0]);
    applySceneTransform(root, object);
    root.traverse((node) => { node.userData.sceneId = object.id; });
  }
  for (const [color, instances] of chairInstances) {
    const material = new THREE.MeshStandardMaterial({ color, roughness: .76, metalness: .05 });
    const mesh = new THREE.InstancedMesh(getChairGeometry(), material, instances.length);
    mesh.name = 'seating';
    mesh.userData.sceneIds = instances.map((object) => object.userData.sceneId);
    instances.forEach((object, index) => mesh.setMatrixAt(index, object.matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox(); mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return { group, objects, dispose() {
    if (disposed) return;
    disposed = true; abort.abort();
    disposeObjects([group, ...parsedModels.values()]);
    parsedModels.clear(); pendingModels.clear(); videoTextures.clear();
  } };
}
