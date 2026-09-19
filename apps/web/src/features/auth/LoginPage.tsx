import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useLogin } from '../../api/hooks.ts';
import { AuthShell } from './AuthShell.tsx';
import { ApiError } from '../../api/client.ts';

/** `/login` — 05_FRONTEND §5.5.1. Labels are always visible, never placeholder-as-label. */
export function LoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);

  const dest = params.get('from') || '/dashboard';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate(dest, { replace: true }) });
  };

  const problem = login.error instanceof ApiError ? login.error.problem : null;

  return (
    <AuthShell>
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h2 className="auth-heading">Sign in</h2>
        <p className="auth-sub muted">Operational access to the investigation workspace.</p>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="password">Password</label>
        <div className="input-affix">
          <input
            id="password"
            name="password"
            type={reveal ? 'text' : 'password'}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="input-affix-btn"
            aria-pressed={reveal}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>

        <div className="form-error" role="alert" aria-live="polite">
          {login.isError
            ? (problem?.detail ?? 'Sign in failed. Check your details and try again.')
            : ''}
        </div>

        <button type="submit" className="btn-primary" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="auth-alt">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </AuthShell>
  );
}
