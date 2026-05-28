#!/usr/bin/env python3
"""
PANNs (Pretrained Audio Neural Networks) AudioSet-527 tagging server.
SPAN-family detector — emits one span per (top-class, time range) hit, so
the UI can show "guitar at 0:20-0:45", "drums at 0:35-1:10", etc.

Lives in its own sidecar (separate from span_server.py :8009) so the
~80 MB torch checkpoint download is opt-in via the `experimental-models`
profile, and a panns-inference install hiccup doesn't take Silero-VAD /
JDCNet down with it.

Detector
--------
  panns-cnn14     CNN14 pretrained on AudioSet-2M (Kong et al. 2020).
                  Released under Apache-2.0 by the authors; weights pulled
                  from the panns_inference pip package's default URL.

Endpoints
---------
  GET  /api/panns/health              → server up + dep availability
  GET  /api/panns/algorithms          → [{ id, name, available, description }]
  GET  /api/panns/detect/:slug/:algo  → cached result, or null
  POST /api/panns/detect              { slug, algo, force? }
  POST /api/panns/initialize          { algo }  — warm weights without running

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "spans": [
      {
        "start":      float,
        "end":        float,
        "label":      str,     # AudioSet class name, e.g. "Drum kit"
        "confidence": float    # max P(class) inside the span
      }
    ],
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/panns/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8013

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, PANNS_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import torch  # noqa: F401
    _TORCH_OK = True
except ImportError:
    _TORCH_OK = False

try:
    import librosa
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False

try:
    import panns_inference  # noqa: F401
    _PANNS_OK = True
except Exception:
    _PANNS_OK = False


# Process-wide model cache. PANNs loads in a couple of seconds; keep it alive.
_panns_tagger = None


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "spans": []}


def _ensure_panns():
    """Lazy-load the PANNs CNN14 tagger. Triggers a one-time ~80 MB checkpoint
    download into ~/.cache/panns_data/ on first call; subsequent calls reuse
    the in-memory model."""
    global _panns_tagger
    if _panns_tagger is not None:
        return
    from panns_inference import AudioTagging
    _panns_tagger = AudioTagging(checkpoint_path=None, device="cpu")


def _audioset_labels() -> list[str]:
    """Pull the 527 AudioSet class names from panns_inference.config.labels
    (a list[str] of length 527 in author-curated display form)."""
    from panns_inference.config import labels
    return list(labels)


# Per-tag voicing-style detection: slide a 1 s window with 0.5 s hop, score
# each window with PANNs, threshold the per-class probability, and collapse
# contiguous hits into spans.
def detect_panns_cnn14(audio_path: Path) -> dict:
    algo = "panns-cnn14"
    if not (_PANNS_OK and _TORCH_OK and _LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "panns_inference / torch / librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_panns()
        # PANNs expects 32 kHz mono.
        sr = 32000
        y, _ = librosa.load(str(audio_path), sr=sr, mono=True)
        duration = float(len(y) / sr)

        # Window-based scoring. 1.0 s window, 0.5 s hop — coarse enough that
        # the tagger sees enough context to commit to a class, fine enough
        # to localize instrument changes.
        WIN_S = 1.0
        HOP_S = 0.5
        win_n = int(WIN_S * sr)
        hop_n = int(HOP_S * sr)
        if len(y) < win_n:
            y = np.pad(y, (0, win_n - len(y)))
        n_windows = max(1, 1 + (len(y) - win_n) // hop_n)
        windows = np.stack(
            [y[i * hop_n : i * hop_n + win_n] for i in range(n_windows)],
            axis=0,
        )

        # AudioTagging.inference is batched (B, win_n) → (B, 527).
        # Force a fresh inference per batch to avoid memory pressure on long tracks.
        BATCH = 16
        scores_chunks: list[np.ndarray] = []
        for i in range(0, n_windows, BATCH):
            chunk = windows[i : i + BATCH].astype(np.float32)
            scores, _embeds = _panns_tagger.inference(chunk)  # type: ignore[union-attr]
            scores_chunks.append(np.asarray(scores))
        scores = np.concatenate(scores_chunks, axis=0)  # (n_windows, 527)

        labels = _audioset_labels()

        # Per-class threshold. AudioSet probabilities are calibrated low,
        # so 0.2 is a reasonable starting point; the eval UI can re-threshold
        # post-hoc once we expose it.
        THRESH = 0.2
        MIN_BARS = 1  # minimum-length filter, in windows = 0.5 s

        spans: list[dict] = []
        # Limit to top-K classes globally so output isn't drowned by faint
        # background labels — keep classes with at least one window above
        # 1.5× threshold, capped at 12 distinct labels.
        peak_per_class = scores.max(axis=0)
        kept_classes = np.argsort(peak_per_class)[::-1]
        kept_classes = [int(c) for c in kept_classes if peak_per_class[c] > THRESH * 1.5][:12]

        for class_idx in kept_classes:
            label = labels[class_idx]
            mask = scores[:, class_idx] > THRESH
            i = 0
            while i < n_windows:
                if not mask[i]:
                    i += 1; continue
                j = i
                while j < n_windows and mask[j]:
                    j += 1
                if j - i >= MIN_BARS:
                    start_t = i * HOP_S
                    end_t   = min(duration, j * HOP_S + WIN_S)
                    conf    = float(scores[i:j, class_idx].max())
                    spans.append({
                        "start":      float(start_t),
                        "end":        float(end_t),
                        "label":      label,
                        "confidence": conf,
                    })
                i = j

        spans.sort(key=lambda s: (s["start"], s["end"]))
        return {
            "algorithm": algo,
            "ok":        True,
            "spans":     spans,
            "duration":  duration,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


ALGORITHMS = {
    "panns-cnn14": {
        "name":        "PANNs CNN14 · AudioSet-527",
        "description": "Multi-label audio tagging pretrained on AudioSet (Kong et al. 2020). 1 s window with 0.5 s hop; top-12 classes globally.",
        "detect":      detect_panns_cnn14,
        "available":   lambda: _PANNS_OK and _TORCH_OK and _LIBROSA_OK and _NUMPY_OK,
    },
}


def detect_one(slug: str, algo: str, force: bool = False) -> dict:
    if algo not in ALGORITHMS:
        raise ValueError(f"unknown algorithm: {algo}")
    cache_dir = CACHE_DIR / slug
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{algo}.json"
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())
    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")
    result = ALGORITHMS[algo]["detect"](audio_path)
    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "algorithm":   algo,
        "duration":    result.get("duration", 0.0),
        "spans":       result.get("spans", []),
        "ok":          result.get("ok", False),
        "error":       result.get("error"),
        "ms":          result.get("ms", 0),
        "computed_at": _now_iso(),
    }
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


def _cors():
    return {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _cors().items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/panns/health":
            self._send(200, {
                "ok":         _PANNS_OK and _TORCH_OK and _LIBROSA_OK and _NUMPY_OK,
                "pannsOk":    _PANNS_OK,
                "torchOk":    _TORCH_OK,
                "librosaOk":  _LIBROSA_OK,
                "numpyOk":    _NUMPY_OK,
            })
            return
        if path == "/api/panns/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/panns/detect/"):
            tail = path[len("/api/panns/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/panns/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            self._send(200, json.loads(cache_path.read_text()) if cache_path.exists() else None)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"})
            return
        if path == "/api/panns/detect":
            slug = str(body.get("slug", "")).strip()
            algo = str(body.get("algo", "")).strip()
            force = bool(body.get("force", False))
            if not slug or not algo:
                self._send(400, {"error": "slug and algo are required"})
                return
            try:
                self._send(200, detect_one(slug, algo, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except ValueError as e:
                self._send(400, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return
        if path == "/api/panns/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            try:
                if not ALGORITHMS[algo]["available"]():
                    self._send(503, {"ok": False, "error": "panns_inference deps missing"})
                    return
                _ensure_panns()
                self._send(200, {"ok": True, "algorithm": algo})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting PANNs server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  panns={_PANNS_OK}  torch={_TORCH_OK}  librosa={_LIBROSA_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
