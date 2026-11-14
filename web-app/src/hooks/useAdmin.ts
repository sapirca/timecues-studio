import { useCallback, useEffect, useState } from 'react';
import { fetchAdminStatus, type AdminStatus } from '../services/admin';
import { useAnnotator } from '../context/AnnotatorContext';

interface UseAdminResult {
  status: AdminStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

/** Resolve the current annotator's admin standing. Re-fetches when the signed-in
 *  annotator changes (sign-in/out flow). UI components should treat
 *  `status === null && loading` as "unknown — render nothing admin-only yet". */
export function useAdmin(): UseAdminResult {
  const { annotator } = useAnnotator();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // A failed lookup (server restarting) keeps the last answer instead of
  // turning an admin into "not admin" until the next full reload.
  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await fetchAdminStatus()); return true; }
    catch { return false; }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!annotator) { setStatus(null); setLoading(false); return; }
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      clearTimeout(retry);
      if (!(await load())) retry = setTimeout(() => void check(), 5000);
    };
    // Standing can change while the tab sits open (a restored people list, an
    // admin elsewhere promoting you), so ask again whenever you come back to it.
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(retry); document.removeEventListener('visibilitychange', onVisible); };
  }, [annotator, load]);

  return { status, loading, refresh: async () => { await load(); } };
}
