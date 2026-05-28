import { useAdmin } from '../hooks/useAdmin';
import { Navigate } from 'react-router-dom';

/** Route-level guard. `tier="admin"` (default) limits to admin only;
 *  `tier="researcher"` admits admin *or* researcher (used for /team so the
 *  cross-annotator dashboard is visible to non-admin researchers). While the
 *  admin status is still loading we render a tiny placeholder instead of
 *  redirecting, to avoid a flash of "not authorized" for the legitimate case.
 *  The server enforces the same check on its endpoints — this is the UX
 *  gate, not the security gate. */
export function RequireAdmin({
  children,
  tier = 'admin',
}: {
  children: React.ReactNode;
  tier?: 'admin' | 'researcher';
}) {
  const { status, loading } = useAdmin();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0b0d] text-slate-500 flex items-center justify-center text-xs">
        Checking access…
      </div>
    );
  }
  const allowed = tier === 'admin' ? status?.isAdmin : status?.isResearcher;
  if (!allowed) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
