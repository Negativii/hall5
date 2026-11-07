import { SurfaceKey } from '../lib/types';

interface MiniSurface {
  key: SurfaceKey;
  num: number;
  label: string;
  posterUrl: string | null;
}

const AREAS: Record<SurfaceKey, string> = {
  right: 'right',
  center: 'center',
  floor: 'floor',
  back: 'back',
  left: 'left',
};

export function MiniNet({
  surfaces,
  className,
  showLabels = true,
}: {
  surfaces: MiniSurface[];
  className?: string;
  showLabels?: boolean;
}) {
  const byKey = new Map(surfaces.map((surface) => [surface.key, surface]));
  return (
    <div className={`mini-net ${className || ''}`} aria-hidden="true">
      {(['right', 'center', 'floor', 'back', 'left'] as SurfaceKey[]).map((key) => {
        const surface = byKey.get(key);
        return (
          <div key={key} className={`mini-net__cell mini-net__cell--${AREAS[key]}`}>
            {surface?.posterUrl ? (
              <img src={surface.posterUrl} alt="" loading="lazy" />
            ) : (
              <span className="mini-net__placeholder">{surface?.num || ''}</span>
            )}
            {showLabels && surface ? <span className="mini-net__label">{surface.label}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
