import type { SurfaceKey } from './types';

export type Vec3 = [number, number, number];
export type SceneObjectType = 'screen' | 'wall' | 'floor' | 'podium' | 'table' | 'chair' | 'block' | 'model';
export interface SceneAsset { id: string; name: string; url: string }
export interface SceneObject {
  id: string;
  type: SceneObjectType;
  name: string;
  position: Vec3;
  rotation: Vec3;
  size: Vec3;
  color: string;
  source: SurfaceKey | null;
  assetId?: string;
}
export interface SceneConfig {
  version: 1;
  room: { width: number; depth: number; height: number };
  showRoomSurfaces: boolean;
  objects: SceneObject[];
  assets: SceneAsset[];
}
export const OBJECT_LABELS: Record<SceneObjectType, string> = {
  screen: 'Экран', wall: 'Стена', floor: 'Пол', podium: 'Подиум', table: 'Стол', chair: 'Стул', block: 'Блок', model: '3D-модель',
};
export function defaultScene(): SceneConfig {
  return { version: 1, room: { width: 20, depth: 10, height: 5 }, showRoomSurfaces: true, objects: [], assets: [] };
}
export function makeSceneObject(type: SceneObjectType): SceneObject {
  const sizes: Record<SceneObjectType, Vec3> = {
    screen: [4, 2.25, .08], wall: [4, 3, .15], floor: [4, .05, 4], podium: [4, .5, 2], table: [1.6, .75, .8], chair: [.5, .9, .5], block: [1, 1, 1], model: [1, 1, 1],
  };
  return {
    id: crypto.randomUUID(), type, name: OBJECT_LABELS[type], position: [0, 0, 0], rotation: [0, 0, 0],
    size: sizes[type], color: type === 'screen' ? '#f5f5f5' : '#8d92a4', source: type === 'screen' ? 'right' : null,
  };
}
export function sceneFingerprint(scene: SceneConfig): string {
  const { assets: _assets, ...editable } = scene;
  return JSON.stringify(editable);
}
