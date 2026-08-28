import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLogin } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';

/** `/login` — 05_FRONTEND §5.5.1. Labels are always visible, never placeholder-as-label. */
export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate(
      { email, password },
      { onSuccess: () => navigate('/investigations', { replace: true }) },
    );
  };

  const problem = login.error instanceof ApiError ? login.error.problem : null;

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1>Sign in</h1>
        <p className="auth-sub">VARUNA — maritime spill attribution</p>

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
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {/* Reserved space so validation does not shift the layout (04_UIUX §4.8.1). */}
        <div className="form-error" role="alert" aria-live="polite">
          {login.isError
            ? (problem?.detail ?? 'Sign in failed. Check your details and try again.')
            : ''}
        </div>

        <button type="submit" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="auth-alt">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>
    </main>
  );
}
