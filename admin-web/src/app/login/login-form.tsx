'use client';

import { useState } from 'react';

/**
 * The sign-in form.
 *
 * It posts to `/api/auth/login` and then does a full navigation rather than a
 * client-side route change. The session cookie has just been set, and a full load
 * makes the middleware evaluate the destination from scratch instead of from a
 * router cache populated before the operator was authenticated.
 *
 * The error it renders is whatever the route said. The route deliberately returns
 * the same message for an unknown email and a wrong password, and this component
 * does not try to be more helpful than that — being more specific here would undo
 * the point of the route's care.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = email.trim().length > 3 && password.length > 0;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid) return;

    setPending(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (!response.ok) {
        const text = await response.text();
        let message = `Sign-in failed with status ${response.status}.`;
        try {
          const parsed: unknown = JSON.parse(text);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'error' in parsed &&
            typeof (parsed as { error?: { message?: unknown } }).error?.message === 'string'
          ) {
            message = (parsed as { error: { message: string } }).error.message;
          }
        } catch {
          // Non-JSON body; the status is the useful part.
        }
        setError(message);
        setPassword('');
        return;
      }

      window.location.assign(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Network error.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="space-y-4 rounded-lg border border-ink-200 bg-white p-5"
    >
      <div>
        <label className="block text-xs font-medium text-ink-600" htmlFor="email">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
          required
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-600" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
          required
        />
      </div>

      <button
        type="submit"
        disabled={!valid || pending}
        className="w-full rounded-md bg-ink-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-ink-800 disabled:bg-ink-300"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {error !== null && (
        <p className="text-xs text-rose-700" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
