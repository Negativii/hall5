const TYPES = new Set(['screen', 'wall', 'floor', 'podium', 'table', 'chair', 'block', 'model']);
const SOURCES = new Set(['right', 'back', 'left', 'center', 'floor']);
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function number(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(`${label}: нужно число от ${min} до ${max}`);
  }
  return value;
}

function vector(value, min, max, label) {
  if (!Array.isArray(value) || value.length !== 3) invalid(`${label}: нужны три координаты`);
  return value.map((v) => number(v, min, max, label));
}

export function defaultScene() {
  return { version: 1, room: { width: 20, depth: 10, height: 5 }, showRoomSurfaces: true, objects: [] };
}

export function normalizeScene(value, assets = []) {
  if (!value || value.version !== 1 || !value.room || !Array.isArray(value.objects)) {
    invalid('Некорректная сцена');
  }
  if (value.objects.length > 200) invalid('В сцене может быть не больше 200 объектов');
  const ids = new Set();
  const assetIds = new Set(assets.map((a) => a.id));
  return {
    version: 1,
    room: {
      width: number(value.room.width, 1, 200, 'Ширина зала'),
      depth: number(value.room.depth, 1, 200, 'Длина зала'),
      height: number(value.room.height, 0.5, 50, 'Высота зала'),
    },
    showRoomSurfaces: value.showRoomSurfaces !== false,
    objects: value.objects.map((object) => {
      if (!object || !ID.test(object.id) || ids.has(object.id)) invalid('Некорректный или повторный ID объекта');
      ids.add(object.id);
      if (!TYPES.has(object.type)) invalid('Неизвестный тип объекта');
      if (typeof object.name !== 'string' || !object.name.trim() || object.name.length > 120) invalid('Укажите имя объекта до 120 символов');
      if (typeof object.color !== 'string' || !/^#[\da-f]{6}$/i.test(object.color)) invalid('Некорректный цвет');
      if (object.source != null && !SOURCES.has(object.source)) invalid('Неизвестный видеоканал');
      if (object.type === 'model' && !assetIds.has(object.assetId)) invalid('Модель не найдена в этом проекте');
      return {
        id: object.id,
        type: object.type,
        name: object.name.trim(),
        position: vector(object.position, -500, 500, 'Положение'),
        rotation: vector(object.rotation, -3600, 3600, 'Поворот'),
        size: vector(object.size, 0.01, 200, 'Размер'),
        color: object.color,
        source: object.type === 'screen' || object.type === 'floor' ? object.source ?? null : null,
        ...(object.type === 'model' ? { assetId: object.assetId } : {}),
      };
    }),
  };
}

// Structural/resource validation before GLTFLoader receives the uploaded bytes.
// GLB 2.0 container: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format-specification
export function validateGlb(bytes) {
  if (bytes.length < 20 || bytes.length > 50 * 1024 ** 2) invalid('Нужен GLB-файл размером до 50 МБ');
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    invalid('Повреждённый GLB: ожидается бинарный glTF 2.0');
  }
  let offset = 12;
  let json;
  let binaryLength = 0;
  let chunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid('Повреждённый заголовок GLB');
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 || offset + length > bytes.length) invalid('Повреждённый блок GLB');
    if (!chunks && type !== 0x4e4f534a) invalid('В GLB отсутствует JSON-блок');
    if (type === 0x4e4f534a) {
      if (json) invalid('В GLB повторяется JSON-блок');
      try { json = JSON.parse(bytes.toString('utf8', offset, offset + length).trim()); }
      catch { invalid('Не удалось прочитать описание GLB'); }
    } else if (type === 0x004e4942) {
      if (binaryLength) invalid('В GLB повторяется бинарный блок');
      binaryLength = length;
    }
    offset += length;
    chunks += 1;
  }
  if (!json || json.asset?.version !== '2.0' || !Array.isArray(json.meshes) || !json.meshes.length) invalid('В GLB нет 3D-геометрии');
  for (const key of ['nodes', 'scenes', 'meshes', 'accessors', 'bufferViews', 'buffers', 'images', 'textures', 'materials', 'extensionsRequired']) {
    if (json[key] !== undefined && !Array.isArray(json[key])) invalid(`Некорректное поле GLB: ${key}`);
  }
  for (const key of ['nodes', 'scenes', 'meshes', 'accessors', 'bufferViews', 'buffers', 'images', 'textures', 'materials']) {
    if (json[key]?.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) invalid(`Повреждённое описание GLB: ${key}`);
  }
  if ((json.nodes?.length || 0) > 1000 || json.meshes.length > 1000 || (json.textures?.length || 0) > 64) invalid('Модель слишком сложная: сократите объекты или текстуры');
  const unsupported = (json.extensionsRequired || []).filter((name) => ![
    'KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_transmission',
    'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_sheen',
    'KHR_materials_volume', 'KHR_materials_emissive_strength', 'KHR_texture_transform',
    'KHR_mesh_quantization', 'KHR_lights_punctual', 'EXT_texture_webp',
  ].includes(name));
  if (unsupported.length) invalid('Экспортируйте GLB без Draco, Meshopt, KTX2 и неподдерживаемых расширений');
  for (const buffer of json.buffers || []) {
    if (buffer.uri || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || buffer.byteLength > binaryLength) invalid('GLB должен содержать встроенные буферы');
  }
  for (const image of json.images || []) {
    if (image.uri && !/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(image.uri)) invalid('Текстуры должны быть встроены в GLB, внешние ссылки не поддерживаются');
    if (!image.uri && !Number.isSafeInteger(image.bufferView)) invalid('В GLB отсутствует текстура');
  }
  let vertices = 0;
  let primitives = 0;
  for (const mesh of json.meshes) {
    if (!Array.isArray(mesh.primitives)) invalid('Некорректные части модели GLB');
    for (const primitive of mesh.primitives || []) {
      if (!primitive || typeof primitive !== 'object') invalid('Некорректная часть модели GLB');
      primitives += 1;
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      if (!accessor || !Number.isSafeInteger(accessor.count) || accessor.count < 0) invalid('Некорректная геометрия GLB');
      vertices += accessor.count;
    }
  }
  if (!primitives || primitives > 2000 || vertices > 1_000_000) invalid('Модель слишком тяжёлая: максимум 1 млн вершин и 2000 частей');
  for (const view of json.bufferViews || []) {
    if (view.buffer !== 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0 || !Number.isSafeInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset || 0) + view.byteLength > binaryLength) invalid('Повреждённые буферы GLB');
  }
  const nodes = json.nodes || [];
  const states = new Uint8Array(nodes.length);
  const parents = new Set();
  const checkIndex = (index, length) => Number.isSafeInteger(index) && index >= 0 && index < length;
  for (const node of nodes) {
    if (node.mesh !== undefined && !checkIndex(node.mesh, json.meshes.length)) invalid('Не найдена геометрия узла GLB');
    if (node.children !== undefined && !Array.isArray(node.children)) invalid('Некорректные дочерние объекты GLB');
    for (const child of node.children || []) {
      if (!checkIndex(child, nodes.length) || parents.has(child)) invalid('Некорректная иерархия GLB');
      parents.add(child);
    }
  }
  const visit = (index, depth) => {
    if (depth > 128 || states[index] === 1) invalid('Циклическая или слишком глубокая иерархия GLB');
    if (states[index] === 2) return;
    states[index] = 1;
    for (const child of nodes[index].children || []) visit(child, depth + 1);
    states[index] = 2;
  };
  nodes.forEach((node, index) => visit(index, 0));
  for (const scene of json.scenes || []) {
    if (scene.nodes !== undefined && !Array.isArray(scene.nodes)) invalid('Некорректная сцена GLB');
    if (scene.nodes?.some((index) => !checkIndex(index, nodes.length))) invalid('Не найден объект сцены GLB');
  }
  return { vertices, meshes: json.meshes.length };
}
