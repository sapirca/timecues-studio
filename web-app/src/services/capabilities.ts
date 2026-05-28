// Single source of truth for "is the optional gpu-tools service installed?"
//
// The capability flag is baked into the gpu-tools Docker image at build time
// (docker/gpu-tools.Dockerfile) and copied into the shared data volume by the
// container entrypoint. The web dev server exposes it at /api/capabilities
// (web-app/vite.config.ts → serveCapabilities). Everything that depends on
// allin1 (mir-aidj) or Demucs output reads from here — never probes for
// individual song artifacts to decide whether the tooling exists.

export type CapabilityVariant = 'cuda' | 'cpu' | 'host' | 'unknown';
export type CapabilitySpeed = 'fast' | 'slow' | 'unknown';
export type CapabilitySource = 'docker-marker' | 'host-python' | 'absent';

export interface Capabilities {
  /** mir-aidj allin1 model is reachable (Docker image or host Python). */
  allin1: boolean;
  /** htdemucs source separation is reachable. */
  demucs: boolean;
  /** Build/install variant:
   *  - 'cuda'    = Docker gpu-tools profile (CUDA wheels, fast)
   *  - 'cpu'     = Docker cpu-tools profile (CPU torch, slow)
   *  - 'host'    = local Python install on the dev host (e.g. via run.sh)
   *  - 'unknown' = detected but couldn't categorize
   */
  variant: CapabilityVariant;
  /** Performance hint for the user — derived from variant + CUDA availability. */
  speed: CapabilitySpeed;
  /** Where the answer came from:
   *  - 'docker-marker' = read the file baked into the Docker image
   *  - 'host-python'   = probed `python -c "import allin1; import demucs"` directly
   *  - 'absent'        = neither path produced a result
   */
  source: CapabilitySource;
}

const CACHE_KEY = 'timecues.capabilities.v1';
const CACHE_TTL_MS = 60_000;

interface CacheEntry { value: Capabilities; at: number; }

let inflight: Promise<Capabilities> | null = null;

function readCache(): Capabilities | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.value;
  } catch { return null; }
}

function writeCache(value: Capabilities): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ value, at: Date.now() })); } catch { /* quota */ }
}

export async function fetchCapabilities(opts?: { force?: boolean }): Promise<Capabilities> {
  if (!opts?.force) {
    const cached = readCache();
    if (cached) return cached;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const url = opts?.force ? '/api/capabilities?force=1' : '/api/capabilities';
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const value = await res.json() as Capabilities;
      writeCache(value);
      return value;
    } catch {
      // Endpoint unavailable → treat as not installed. We don't write this to
      // cache so a transient failure isn't sticky.
      return { allin1: false, demucs: false, variant: 'unknown', speed: 'unknown', source: 'absent' };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export const GPU_TOOLS_UNAVAILABLE_HINT =
  'Requires `allin1` AND `demucs` importable from the dev server\'s Python. ' +
  'Docker route: `docker compose --profile demucs-cpu up` (slow, multi-arch) ' +
  'or `--profile demucs-gpu` (CUDA, fast). Local route: ./run.sh installs them ' +
  'automatically by default — set SKIP_MODEL_INSTALL=1 to skip. Manual install: ' +
  '`pip install -r tools/python/requirements.txt` (covers demucs), then ' +
  '`pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu` ' +
  'and `pip install -r tools/requirements-allin1.txt`. Restart the dev server ' +
  '(or hit Settings → Refresh) so the capabilities probe re-runs.';
