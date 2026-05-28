#!/usr/bin/env python3
"""
LOOP-family detection server — finds seamless N-bar loop candidates via
chroma-vector autocorrelation. Pure DSP, no model weights.

Algorithm (matches the integration-plan v0 recipe):
  1. CQT-derived chroma vectors at the song's beat resolution.
  2. Self-similarity matrix from chroma cosine distances.
  3. Beat-aligned autocorrelation peaks pick the most likely repeat period.
  4. Score each candidate (start_bar, length_bars) by how cleanly the chroma
     repeats across the candidate window; keep the top-K above a threshold.

Detector
--------
  chroma-autocorr   librosa chroma_cqt + onset.beat_track + manual SSM-based
                    period detection. No model weights. Fast (~5–10 s for 3 min).

Endpoints
---------
  GET  /api/loop/health              → server up + librosa availability
  GET  /api/loop/algorithms          → [{ id, name, available, description }]
  GET  /api/loop/detect/:slug/:algo  → cached result, or null
  POST /api/loop/detect              { slug, algo, force? }

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "loops": [
      {
        "start":      float,     # seconds
        "end":        float,     # seconds
        "label":      str,       # e.g. "8 bars · score 0.91"
        "bars":       int | None,
        "confidence": float      # 0..1, mean intra-loop chroma similarity
      }
    ],
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/loop/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8012

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, LOOP_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── Optional imports ───────────────────────────────────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa
    _LIBROSA_OK = True
except ImportError:
    _LIBROSA_OK = False


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "loops": []}


# ─── Detector: chroma autocorrelation loop finder ───────────────────────────


def _detect_chroma_loops(
    y: "np.ndarray",
    sr: int,
    *,
    min_bars: int = 4,
    max_bars: int = 16,
    top_k: int = 6,
    min_score: float = 0.55,
) -> tuple[list[dict], float]:
    """Return (loops, duration_seconds). Pure DSP — no model.

    Logic:
      1. Estimate beats + tempo with librosa.
      2. Compute beat-synchronous chroma (one chroma vector per beat).
      3. For each candidate cycle length L ∈ [min_bars*4, max_bars*4] beats and
         each candidate start beat s, score the loop as the mean cosine
         similarity between beats [s, s+L) and beats [s+L, s+2L).
      4. Keep non-overlapping high-score candidates.
    """
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    if len(beats) < min_bars * 4 + 4:
        return [], float(len(y) / sr)

    chroma  = librosa.feature.chroma_cqt(y=y, sr=sr)
    # Beat-synchronous chroma (12 × N_beats)
    chroma_b = librosa.util.sync(chroma, beats, aggregate=np.median)
    n_beats  = chroma_b.shape[1]

    # Normalize each column so cosine sim == dot product / nothing else.
    norms = np.linalg.norm(chroma_b, axis=0, keepdims=True)
    norms[norms < 1e-9] = 1e-9
    cn = chroma_b / norms

    beat_times = librosa.frames_to_time(beats, sr=sr)
    duration = float(len(y) / sr)
    # beats are quarter-notes; one bar = 4 beats (4/4 assumption — the meter
    # field on the song would refine this but it isn't reachable here).
    BEATS_PER_BAR = 4

    candidates: list[dict] = []
    for bars in range(min_bars, max_bars + 1):
        L = bars * BEATS_PER_BAR  # length in beats
        if 2 * L > n_beats:
            break
        for s in range(0, n_beats - 2 * L + 1):
            # cosine sim between two adjacent cycles
            a = cn[:, s : s + L]
            b = cn[:, s + L : s + 2 * L]
            # Mean diagonal of A.T @ B gives the per-beat similarity between
            # corresponding beats of the two cycles — the right thing for a
            # "this segment really does loop" score.
            sim = float(np.mean(np.sum(a * b, axis=0)))
            if sim < min_score:
                continue
            start_t = float(beat_times[s])
            end_t   = float(beat_times[s + L] if s + L < len(beat_times) else duration)
            if end_t - start_t < 1.0:
                continue
            candidates.append({
                "start":      start_t,
                "end":        end_t,
                "label":      f"{bars} bars · score {sim:.2f}",
                "bars":       int(bars),
                "confidence": sim,
                # internal-only fields for non-overlap pruning
                "_s": s, "_L": L,
            })

    # Sort by score descending, then prune overlaps (keep highest-scoring).
    candidates.sort(key=lambda c: -c["confidence"])
    kept: list[dict] = []
    for c in candidates:
        cs, ce = c["start"], c["end"]
        if any(not (ce <= k["start"] or cs >= k["end"]) for k in kept):
            continue
        kept.append(c)
        if len(kept) >= top_k:
            break

    # Order kept loops by start time for the UI; strip internal fields.
    kept.sort(key=lambda c: c["start"])
    return ([{k: v for k, v in c.items() if not k.startswith("_")} for c in kept], duration)


def detect_chroma_autocorr(audio_path: Path) -> dict:
    algo = "chroma-autocorr"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        loops, duration = _detect_chroma_loops(y, sr)
        return {
            "algorithm": algo,
            "ok":        True,
            "loops":     loops,
            "duration":  duration,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Algorithm registry ─────────────────────────────────────────────────────

ALGORITHMS = {
    "chroma-autocorr": {
        "name":        "Chroma autocorrelation",
        "description": "Pure-DSP loop finder. Beat-synchronous chroma + cosine similarity scoring. No model weights.",
        "detect":      detect_chroma_autocorr,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK,
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
        "loops":       result.get("loops", []),
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


# ─── HTTP handler ───────────────────────────────────────────────────────────

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
        if path == "/api/loop/health":
            self._send(200, {"ok": _LIBROSA_OK and _NUMPY_OK, "librosaOk": _LIBROSA_OK, "numpyOk": _NUMPY_OK})
            return
        if path == "/api/loop/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/loop/detect/"):
            tail = path[len("/api/loop/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/loop/detect/<slug>/<algo>"})
                return
            slug, algo = tail
            cache_path = CACHE_DIR / slug / f"{algo}.json"
            if cache_path.exists():
                self._send(200, json.loads(cache_path.read_text()))
            else:
                self._send(200, None)
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
        if path == "/api/loop/detect":
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
        # Pure-DSP detectors have nothing to "initialize" — short-circuit to ok
        # so the Initialize-Models panel flips to Ready immediately.
        if path == "/api/loop/initialize":
            algo = str(body.get("algo", "")).strip()
            if algo not in ALGORITHMS:
                self._send(400, {"error": f"unknown algorithm: {algo}"})
                return
            self._send(200, {"ok": ALGORITHMS[algo]["available"](), "algorithm": algo})
            return
        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting LOOP server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  librosa={_LIBROSA_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
