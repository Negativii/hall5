import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Project, toPlayerProject } from '../lib/types';
import { Player } from '../components/player/Player';
import { Spinner } from '../components/ui';

export function AdminPresentPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const videoSceneId = searchParams.get('videoScene') || 'main';
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setProject(null);
    setError('');
    api<{ project: Project }>(`/api/projects/${id}?videoScene=${encodeURIComponent(videoSceneId)}`)
      .then((data) => {
        if (alive) setProject(data.project);
      })
      .catch((caught) => {
        if (alive) {
          setError(
            caught instanceof ApiError && caught.status === 401
              ? 'Сессия истекла'
              : 'Не удалось открыть показ',
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [id, videoSceneId]);

  if (error) {
    return (
      <div className="public-boot">
        <p>{error}</p>
        <Link to={`/admin/p/${id}`} className="btn btn--secondary">
          <ArrowLeft size={15} /> В кабинет
        </Link>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="public-boot">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <Player
      key={`${project.id}:${project.videoSceneId || 'main'}:${project.contentRevision}`}
      project={toPlayerProject(project, true)}
      comments={project.comments}
      isAdmin
      backTo={`/admin/p/${project.id}?videoScene=${encodeURIComponent(project.videoSceneId || 'main')}`}
    />
  );
}
