import { useRef, useState } from 'react';
import { Comment } from '../../lib/types';
import { formatTime } from '../../lib/format';

export function Timeline({
  time,
  duration,
  comments,
  onSeekStart,
  onSeek,
  onSeekEnd,
}: {
  time: number;
  duration: number;
  comments: Comment[];
  onSeekStart?: () => void;
  onSeek: (time: number) => void;
  onSeekEnd?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ ratio: number; time: number } | null>(null);

  const value = drag ?? time;
  const ratio = duration > 0 ? Math.min(1, Math.max(0, value / duration)) : 0;

  const locate = (clientX: number): number => {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const next = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return next * duration;
  };

  return (
    <div
      className={`timeline ${drag !== null ? 'is-dragging' : ''}`}
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Перемотка"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(value)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') onSeek(Math.min(duration, time + 5));
        if (event.key === 'ArrowLeft') onSeek(Math.max(0, time - 5));
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
        onSeekStart?.();
        setDrag(locate(event.clientX));
      }}
      onPointerMove={(event) => {
        const next = locate(event.clientX);
        if (drag !== null) {
          setDrag(next);
        } else {
          const track = trackRef.current;
          if (track) {
            const rect = track.getBoundingClientRect();
            setHover({ ratio: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), time: next });
          }
        }
      }}
      onPointerUp={(event) => {
        if (drag === null) return;
        const next = locate(event.clientX);
        setDrag(null);
        onSeek(next);
        onSeekEnd?.();
      }}
      onPointerCancel={() => {
        setDrag(null);
        onSeekEnd?.();
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="timeline__rail">
        <div className="timeline__fill" style={{ width: `${ratio * 100}%` }} />
        <div className="timeline__thumb" style={{ left: `${ratio * 100}%` }} />
        {duration > 0 &&
          comments.map((comment) => (
            <button
              key={comment.id}
              type="button"
              className="timeline__marker"
              style={{ left: `${Math.min(100, Math.max(0, (comment.time / duration) * 100))}%` }}
              title={`${comment.author}: ${comment.text.slice(0, 60)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSeek(comment.time);
              }}
            />
          ))}
      </div>
      {hover ? (
        <span className="timeline__tip" style={{ left: `${hover.ratio * 100}%` }}>
          {formatTime(hover.time)}
        </span>
      ) : null}
    </div>
  );
}
