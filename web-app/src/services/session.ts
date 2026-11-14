// The server-side half of signing in (web-app/server/auth.mjs). The page never
// sees the session itself — it is an HttpOnly cookie — only who it says you are.

export interface ServerSession {
  /** The signed-in id, or null when there is no session. */
  id: string | null;
  method: 'google' | 'local' | null;
  /** Whether username sign-in is open from where this page is loaded. */
  localLogin: boolean;
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
  return data as T;
}

/** Hand Google's ID token to the server, which checks it and opens a session.
 *  The address returned is the verified one — never read it from the token. */
export function startGoogleSession(credential: string): Promise<{ id: string; email: string; name: string }> {
  return post('/api/auth/google', { credential });
}

/** Open a session for a `local-…` username. Refused unless the page is
 *  served to this machine. */
export function startLocalSession(id: string): Promise<{ id: string }> {
  return post('/api/auth/local', { id });
}

export function endSession(): Promise<unknown> {
  return post('/api/auth/logout').catch(() => null);
}

export async function fetchSession(): Promise<ServerSession | null> {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    return (await res.json()) as ServerSession;
  } catch {
    return null;
  }
}
