import {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  forwardRef,
} from 'react';
import { LoaderCircle } from 'lucide-react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <LoaderCircle
      size={size}
      className={cx('spin', className)}
      strokeWidth={1.8}
      aria-hidden="true"
    />
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
  full?: boolean;
};

export function Btn({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  full,
  className,
  children,
  disabled,
  ...rest
}: BtnProps) {
  return (
    <button
      className={cx('btn', `btn--${variant}`, `btn--${size}`, full && 'btn--full', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tone?: 'default' | 'danger';
  active?: boolean;
};

export const IconBtn = forwardRef<HTMLButtonElement, IconBtnProps>(function IconBtn(
  { label, tone = 'default', active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx('icon-btn', tone === 'danger' && 'icon-btn--danger', active && 'is-active', className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('field', className)}>
      {label ? <span className="field__label">{label}</span> : null}
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx('input', className)} {...rest} />;
  },
);

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cx('toggle-row', disabled && 'is-disabled')}>
      <div className="toggle-row__text">
        <span className="toggle-row__label">{label}</span>
        {description ? <span className="toggle-row__desc">{description}</span> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={cx('switch', checked && 'is-on')}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch__dot" />
      </button>
    </div>
  );
}
