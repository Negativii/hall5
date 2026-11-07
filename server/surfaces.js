/**
 * Пять поверхностей проекционного зала 20 × 10 × 5 м.
 * wall: сторона комнаты в 3D-сцене (north = дальняя стена от входа).
 */
export const SURFACES = [
  {
    key: 'right',
    num: 1,
    label: 'RIGHT',
    name: 'Стена 1',
    title: 'Правая стена',
    specW: 4800,
    specH: 1200,
    physical: '20 × 5 м',
    wall: 'north',
  },
  {
    key: 'back',
    num: 2,
    label: 'BACK',
    name: 'Стена 2',
    title: 'Задняя стена',
    specW: 2400,
    specH: 1200,
    physical: '10 × 5 м',
    wall: 'east',
  },
  {
    key: 'left',
    num: 3,
    label: 'LEFT',
    name: 'Стена 3',
    title: 'Левая стена',
    specW: 4800,
    specH: 1200,
    physical: '20 × 5 м',
    wall: 'south',
  },
  {
    key: 'center',
    num: 4,
    label: 'CENTER',
    name: 'Стена 4',
    title: 'Центральная стена',
    specW: 2400,
    specH: 1200,
    physical: '10 × 5 м',
    wall: 'west',
  },
  {
    key: 'floor',
    num: 5,
    label: 'FLOOR',
    name: 'Пол',
    title: 'Пол',
    specW: 4800,
    specH: 2400,
    physical: '20 × 10 м',
    wall: 'floor',
  },
];

export const SURFACE_MAP = Object.fromEntries(SURFACES.map((s) => [s.key, s]));

export const ROOM = { width: 20, depth: 10, height: 5 };
