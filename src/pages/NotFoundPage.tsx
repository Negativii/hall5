import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '../components/Logo';

export function NotFoundPage() {
  return (
    <div className="notfound">
      <Logo link />
      <span className="notfound__code">404</span>
      <h1>Такой страницы нет</h1>
      <p>Возможно, ссылка устарела или в адресе опечатка.</p>
      <Link to="/" className="btn btn--secondary">
        <ArrowLeft size={15} /> На главную
      </Link>
    </div>
  );
}
