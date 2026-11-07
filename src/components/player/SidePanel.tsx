import { useLegalConfig, type FeedbackConsent } from '../../lib/legal';
import { FeedbackConsentField } from '../FeedbackConsent';
import { useEffect, useRef, useState } from 'react';
import { Maximize2, MessageSquare, Send, Volume2, X } from 'lucide-react';
import { Comment, PlayerProject, PlayerSurface } from '../../lib/types';
import { formatTime, initials, relativeDate } from '../../lib/format';
import { Btn, IconBtn } from '../ui';
import { SurfaceBadge } from '../StatusChip';
import { PlayerController } from './usePlayer';

type Tab = 'screens' | 'comments';

export function SidePanel({
  project,
  controller,
  comments,
  tab,
  onTab,
  onClose,
  onSeek,
  onFocus,
  onAddComment,
  canComment,
  isAdmin,
  currentTime,
}: {
  project: PlayerProject;
  controller: PlayerController;
  comments: Comment[];
  currentTime: number;
  tab: Tab;
  onTab: (tab: Tab) => void;
  onClose: () => void;
  onSeek: (time: number) => void;
  onFocus: (surface: PlayerSurface) => void;
  onAddComment?: (author: string, text: string, time: number, consent: FeedbackConsent) => Promise<void>;
  canComment: boolean;
  isAdmin: boolean;
}) {
  return (
    <aside className="sidepanel">
      <div className="sidepanel__head">
        <div className="sidepanel__tabs">
          <button
            className={`sidepanel__tab ${tab === 'screens' ? 'is-active' : ''}`}
            onClick={() => onTab('screens')}
          >
            Поверхности
          </button>
          <button
            className={`sidepanel__tab ${tab === 'comments' ? 'is-active' : ''}`}
            onClick={() => onTab('comments')}
          >
            Отзывы
            {comments.length ? <span className="sidepanel__count">{comments.length}</span> : null}
          </button>
        </div>
        <IconBtn label="Закрыть панель" onClick={onClose}>
          <X size={18} />
        </IconBtn>
      </div>
      {tab === 'screens' ? (
        <div className="sidepanel__body">
          <div className="screens">
            {project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key)).map((surface) => (
              <div key={surface.key} className={`screen-row ${surface.status !== 'ready' ? 'is-missing' : ''}`}>
                <SurfaceBadge num={surface.num} label={surface.label} keyName={surface.key} />
                <div className="screen-row__info">
                  <span className="screen-row__name">{surface.name}</span>
                  <span className="screen-row__meta">
                    {surface.specW} × {surface.specH}
                    {surface.status === 'ready' && surface.duration
                      ? ` · ${formatTime(surface.duration)}`
                      : ' · нет видео'}
                  </span>
                </div>
                <div className="screen-row__actions">
                  {surface.hasAudio ? (
                    <IconBtn
                      label="Звук с этой поверхности"
                      active={!controller.muted && controller.audioKey === surface.key}
                      onClick={() => controller.setAudioKey(surface.key)}
                    >
                      <Volume2 size={15} />
                    </IconBtn>
                  ) : null}
                  <IconBtn label="Развернуть поверхность" onClick={() => onFocus(surface)}>
                    <Maximize2 size={15} />
                  </IconBtn>
                </div>
              </div>
            ))}
          </div>
          <div className="sidepanel__note">
            {project.requiredSurfaceKeys.length ? 'Видео сцены идут от одного таймлайна. Если хронометраж отличается, показ синхронизируется по самой короткой дорожке.' : 'В этой сцене нет видео. Объекты можно осмотреть в 3D.'}
          </div>
        </div>
      ) : (
        <Comments
          project={project}
          comments={comments}
          onSeek={onSeek}
          onAddComment={onAddComment}
          canComment={canComment}
          isAdmin={isAdmin}
          currentTime={currentTime}
        />
      )}
    </aside>
  );
}

function Comments({
  project,
  comments,
  onSeek,
  onAddComment,
  canComment,
  isAdmin,
  currentTime,
}: {
  project: PlayerProject;
  comments: Comment[];
  onSeek: (time: number) => void;
  onAddComment?: (author: string, text: string, time: number, consent: FeedbackConsent) => Promise<void>;
  canComment: boolean;
  isAdmin: boolean;
  currentTime: number;
}) {
  const [author, setAuthor] = useState('');
  const { config: legal } = useLegalConfig();
  const [consented, setConsented] = useState(false);
  const [text, setText] = useState('');
  const [composeTime, setComposeTime] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [comments.length]);

  const submit = async () => {
    if (!onAddComment || pending) return;
    if (!author.trim()) {
      setError('Как вас зовут?');
      return;
    }
    if (!text.trim()) {
      setError('Напишите комментарий');
      return;
    }
    if (!legal?.configured || !consented) { setError('Для отправки отзыва отметьте отдельное согласие.'); return; }
    setPending(true);
    setError('');
    try {
      await onAddComment(author.trim(), text.trim(), composeTime ?? currentTime, { accepted: true, version: legal.consentVersion });
      setConsented(false);
      setText('');
      setComposeTime(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось отправить');
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <div className="comments" ref={listRef}>
        {comments.length === 0 ? (
          <div className="comments__empty">
            <MessageSquare size={26} />
            <span>Пока тихо</span>
            <p>
              {project.allowComments
                ? 'Оставьте замечание на нужной секунде — оно появится у команды в кабинете.'
                : 'Комментарии к этому показу отключены.'}
            </p>
          </div>
        ) : (
          comments.map((comment) => (
            <div key={comment.id} className="comment">
              <div className={`avatar avatar--${hashName(comment.author)}`}>{initials(comment.author)}</div>
              <div className="comment__body">
                <div className="comment__head">
                  <span className="comment__author">{comment.author}</span>
                  <span className="comment__date">{relativeDate(comment.createdAt)}</span>
                </div>
                <button className="timecode" onClick={() => onSeek(comment.time)}>
                  {formatTime(comment.time)}
                </button>
                <p className="comment__text">{comment.text}</p>
              </div>
            </div>
          ))
        )}
      </div>
      {canComment && onAddComment ? (
        <div className="comment-form">
          <div className="comment-form__row">
            <input
              className="input input--ghost"
              placeholder="Ваше имя"
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
              maxLength={40}
            />
            <span className="comment-form__at">на {formatTime(composeTime ?? currentTime)}</span>
          </div>
          <textarea
            className="textarea"
            placeholder="Что поправить?"
            value={text}
            onFocus={() => { if (composeTime === null) setComposeTime(currentTime); }}
            onChange={(event) => {
              const next = event.target.value;
              if (!next) setComposeTime(null);
              else if (composeTime === null) setComposeTime(currentTime);
              setText(next);
            }}
            rows={3}
            maxLength={2000}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
            }}
          />
          <FeedbackConsentField config={legal} checked={consented} onChange={setConsented} />
          {error ? <span className="field__error">{error}</span> : null}
          <div className="comment-form__actions">
            <span className="comment-form__hint">Ctrl + Enter</span>
            <Btn variant="primary" size="sm" onClick={submit} loading={pending} disabled={!legal?.configured || !consented} icon={<Send size={14} />}>
              Отправить
            </Btn>
          </div>
        </div>
      ) : (
        <div className="sidepanel__note">
          {isAdmin
            ? 'Вы в режиме администратора. Отзывы заказчика появятся здесь и в кабинете.'
            : 'Комментарии к этому показу отключены.'}
        </div>
      )}
    </>
  );
}

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 5;
  return hash + 1;
}
