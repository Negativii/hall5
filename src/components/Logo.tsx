import { Link } from 'react-router-dom';

export function Logo({ link = false, compact = false }: { link?: boolean; compact?: boolean }) {
  const content = (
    <>
      <span className="logo__mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      {!compact ? (
        <span className="logo__word">
          KUOG HALL
        </span>
      ) : null}
    </>
  );

  if (link) {
    return (
      <Link to="/" className="logo" aria-label="KUOG HALL — на главную">
        {content}
      </Link>
    );
  }
  return <span className="logo">{content}</span>;
}
