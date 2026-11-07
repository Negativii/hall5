import { useEffect, useRef, useState } from 'react';
import { ChevronUp, Volume2, VolumeX } from 'lucide-react';
import { PlayerSurface, SurfaceKey } from '../../lib/types';
import { IconBtn } from '../ui';

export function SoundControl({
  surfaces,
  muted,
  audioKey,
  volume,
  onToggle,
  onAudio,
  onVolume,
}: {
  surfaces: PlayerSurface[];
  muted: boolean;
  audioKey: SurfaceKey | null;
  volume: number;
  onToggle: () => void;
  onAudio: (key: SurfaceKey) => void;
  onVolume: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const withAudio = surfaces.filter((surface) => surface.hasAudio && surface.status === 'ready');

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!withAudio.length) {
    return (
      <IconBtn label="Без звука" disabled>
        <VolumeX size={18} />
      </IconBtn>
    );
  }

  return (
    <div className="sound" ref={rootRef}>
      <IconBtn label={muted ? 'Включить звук' : 'Выключить звук'} onClick={onToggle}>
        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </IconBtn>
      <button
        type="button"
        className="sound__more"
        aria-label="Настройки звука"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronUp size={12} />
      </button>
      {open ? (
        <div className="sound__menu">
          <div className="sound__volume">
            <span>Громкость</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolume(Number(event.target.value))}
              aria-label="Громкость"
            />
          </div>
          <div className="sound__caption">Звук с поверхности</div>
          {withAudio.map((surface) => (
            <button
              key={surface.key}
              type="button"
              className={`sound__option ${audioKey === surface.key && !muted ? 'is-on' : ''}`}
              onClick={() => onAudio(surface.key)}
            >
              <span className="sound__num">{surface.num}</span>
              <span>{surface.name}</span>
              <span className="sound__label">{surface.label}</span>
            </button>
          ))}
          <p className="sound__note">Одновременно звучит только одна поверхность — так шоу не превращается в кашу.</p>
        </div>
      ) : null}
    </div>
  );
}
