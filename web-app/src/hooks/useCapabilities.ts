import { useEffect, useState } from 'react';
import { fetchCapabilities, type Capabilities } from '../services/capabilities';

interface UseCapabilitiesResult {
  capabilities: Capabilities;
  loading: boolean;
  /** Force a re-fetch (bypasses the localStorage cache). */
  refresh: () => Promise<void>;
}

const DEFAULT_CAPS: Capabilities = { allin1: false, demucs: false, variant: 'unknown', speed: 'unknown', source: 'absent' };

export function useCapabilities(): UseCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<Capabilities>(DEFAULT_CAPS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchCapabilities().then((c) => { if (!cancelled) { setCapabilities(c); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const refresh = async () => {
    setLoading(true);
    const c = await fetchCapabilities({ force: true });
    setCapabilities(c);
    setLoading(false);
  };

  return { capabilities, loading, refresh };
}
