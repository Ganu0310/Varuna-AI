import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useRegister } from '../../api/hooks.ts';
import { AuthShell } from './AuthShell.tsx';
import { ApiError } from '../../api/client.ts';

/** `/register` — 05_FRONTEND §5.5.1. */
export function RegisterPage() {
  const navigate = useNavigate();
  const register = useRegister();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate(
      { name, email, password },
      { onSuccess: () => navigate('/investigations', { replace: true }) },
    );
  };

  const err = register.error instanceof ApiError ? register.error : null;
  const fieldErrors = err?.fieldErrors ?? {};

  return (
    <AuthShell>
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h2 className="auth-heading">Create an account</h2>

        <label htmlFor="name">Name</label>
        <input
          id="name"
          name="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-describedby={fieldErrors.name ? 'name-error' : undefined}
        />
        <div className="field-error" id="name-error">
          {fieldErrors.name ?? ''}
        </div>

        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-describedby={fieldErrors.email ? 'email-error' : undefined}
        />
        <div className="field-error" id="email-error">
          {fieldErrors.email ?? ''}
        </div>

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="password-hint"
        />
        <div className="field-hint" id="password-hint">
          At least 12 characters.
        </div>
        <div className="field-error">{fieldErrors.password ?? ''}</div>

        <div className="form-error" role="alert" aria-live="polite">
          {register.isError && Object.keys(fieldErrors).length === 0
            ? (err?.problem?.detail ?? err?.problem?.title ?? 'Could not create the account.')
            : ''}
        </div>

        <button type="submit" disabled={register.isPending}>
          {register.isPending ? 'Creating…' : 'Create account'}
        </button>

        <p className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
