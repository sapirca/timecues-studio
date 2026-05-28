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

  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await fetchAdminStatus()); }
    catch { setStatus(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!annotator) { setStatus(null); setLoading(false); return; }
    void load();
  }, [annotator, load]);

  return { status, loading, refresh: load };
}
