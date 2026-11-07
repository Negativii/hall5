import { defaultScene } from './sceneSchema.js';
import { mediaToken } from './auth.js';

export function serializeScene(project, isPublic = false) {
  const scene = project.scene || defaultScene();
  const referenced = new Set(scene.objects.map((object) => object.assetId).filter(Boolean));
  const token = isPublic ? mediaToken(project.id, 8 * 60 * 60, project.share?.revision || '0') : null;
  return {
    ...scene,
    assets: (project.sceneAssets || [])
      .filter((asset) => !isPublic || referenced.has(asset.id))
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        url: isPublic
          ? `/api/s/${project.slug}/assets/${asset.id}?mt=${encodeURIComponent(token)}`
          : `/api/projects/${project.id}/assets/${asset.id}`,
      })),
  };
}
