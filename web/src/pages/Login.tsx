import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Field } from '../components/ui';

export default function Login() {
  const { user, login } = useAuth();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) {
    const from = (loc.state as { from?: string } | null)?.from;
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email address and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit} noValidate aria-labelledby="login-h">
        <div className="login__brand">
          <div className="rail__logo" aria-hidden="true">G</div>
          <div>
            <h1 id="login-h">Greenware ERP</h1>
            <p>Sign in with your company account</p>
          </div>
        </div>
        {error ? (
          <div className="notice notice--crit" role="alert">
            <span className="prewrap">{error}</span>
          </div>
        ) : null}
        <Field label="Email" required>
          {(p) => (
            <input {...p} className="input" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@greenware.ae" />
          )}
        </Field>
        <Field label="Password" required>
          {(p) => (
            <input {...p} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
        </Field>
        <button type="submit" className="btn btn--primary" disabled={busy} style={{ height: 34 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
