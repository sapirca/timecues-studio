#!/usr/bin/env python3
"""
PATTERN-family detection server — discovers variable-length repeating motifs
via LoCoMotif (time-warped DTW motif discovery on beat-synchronous chroma).

Algorithm
---------
  locomotif   ML-KULeuven/dtai-locomotif (MIT). Beat-synchronous CQT-chroma is
              z-normalized and handed to apply_locomotif. Each returned motif
              set explodes into one PatternItem per occurrence so the UI's
              "contiguous tile" repetition model isn't violated (motif
              occurrences are not regularly spaced — they're warped matches).

Endpoints
---------
  GET  /api/pattern/health                → server up + locomotif availability
  GET  /api/pattern/algorithms            → [{ id, name, available, description }]
  GET  /api/pattern/detect/:slug/:algo    → cached result, or null
  POST /api/pattern/detect                { slug, algo, force? }
  POST /api/pattern/initialize            { algo }  → no-op (numba JIT warms on first run)

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "algorithm":   str,
    "duration":    float,
    "patterns": [
      {
        "start":            float,    # seconds
        "end":              float,    # seconds
        "label":            str,      # e.g. "Motif 2 · 3/5"
        "motif_id":         int,      # 1-based motif index
        "occurrence_index": int,      # 0-based occurrence inside the motif set
        "occurrence_count": int,      # total occurrences in this motif set
        "confidence":       float     # 0..1, motif-set similarity score
      }
    ],
    "ms":          int,
    "computed_at": str
  }

Cache
-----
  data/algorithm-outputs/pattern/<slug>/<algo>.json
"""

from __future__ import annotations

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8017

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, PATTERN_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

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

try:
    # dtai-locomotif on pypi (MIT, ML-KULeuven). The public entry point lives
    # at locomotif.locomotif.apply_locomotif — the package's __init__.py is
    # intentionally empty, so importing the bare `locomotif` doesn't bring
    # the algorithm into scope.
    from locomotif.locomotif import apply_locomotif as _apply_locomotif
    _LOCOMOTIF_OK = True
except ImportError:
    _apply_locomotif = None  # type: ignore[assignment]
    _LOCOMOTIF_OK = False


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _err(algo: str, msg: str) -> dict:
    return {"algorithm": algo, "ok": False, "error": msg, "patterns": []}


# ─── Detector: LoCoMotif motif discovery ────────────────────────────────────


def _detect_locomotif(
    y: "np.ndarray",
    sr: int,
    *,
    min_bars: int = 4,
    max_bars: int = 16,
    rho: float = 0.6,
) -> tuple[list[dict], float]:
    """Return (patterns, duration_seconds).

    Pipeline:
      1. Beat-track the audio (librosa).
      2. Compute beat-synchronous chroma (12 × N_beats).
      3. Z-normalize each chroma row across beats — LoCoMotif's preferred input.
      4. apply_locomotif with cycle-length window [min_bars*4, max_bars*4] beats.
      5. Explode each motif set into one entry per occurrence.
    """
    _, beats = librosa.beat.beat_track(y=y, sr=sr)
    duration = float(len(y) / sr)
    if len(beats) < min_bars * 4 + 4:
        return [], duration

    chroma  = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_b = librosa.util.sync(chroma, beats, aggregate=np.median)
    n_beats  = chroma_b.shape[1]

    # locomotif wants (n, d) — we have (12, n_beats), so transpose to (n_beats, 12).
    ts = chroma_b.T.astype(np.float64)
    # Z-normalize each dimension across beats.
    mu = ts.mean(axis=0, keepdims=True)
    sd = ts.std(axis=0, keepdims=True)
    sd[sd < 1e-9] = 1e-9
    ts = (ts - mu) / sd

    BEATS_PER_BAR = 4
    l_min = min_bars * BEATS_PER_BAR
    l_max = min(max_bars * BEATS_PER_BAR, max(l_min + 1, n_beats // 2))
    if l_max <= l_min:
        return [], duration

    beat_times = librosa.frames_to_time(beats, sr=sr)
    # locomotif's apply_locomotif uses keyword `warping=True` by default — the
    # whole reason to pick it over plain SSM autocorrelation.
    # apply_locomotif returns a list of motif_sets; each motif_set is a list of
    # (start, end) integer index tuples. The first element of each set is the
    # representative — we treat them all uniformly here and key on motif_idx
    # for grouping in the UI.
    motif_sets = _apply_locomotif(ts, l_min=l_min, l_max=l_max, rho=rho)

    out: list[dict] = []
    for motif_idx, (representative, motif_set) in enumerate(motif_sets, start=1):
        # apply_locomotif returns list[(representative_tuple, occurrences_list)]
        # where representative is a single (start, end) and occurrences is a
        # list of (start, end). The representative is typically also the first
        # element of occurrences.
        occ_count = len(motif_set)
        if occ_count < 2:
            continue
        rep_s, rep_e = representative
        rep_vec = ts[rep_s:rep_e].mean(axis=0)
        rep_norm = np.linalg.norm(rep_vec) or 1.0
        for occ_idx, (s_idx, e_idx) in enumerate(motif_set):
            s_idx, e_idx = int(s_idx), int(e_idx)
            if s_idx >= len(beat_times):
                continue
            start_t = float(beat_times[s_idx])
            if e_idx >= len(beat_times):
                end_t = duration
            else:
                end_t = float(beat_times[e_idx])
            if end_t - start_t < 0.5:
                continue
            occ_vec = ts[s_idx:e_idx].mean(axis=0)
            occ_norm = np.linalg.norm(occ_vec) or 1.0
            sim = float(np.dot(rep_vec, occ_vec) / (rep_norm * occ_norm))
            # Cosine is in [-1, 1]; clip to [0, 1] for a UI-friendly confidence.
            confidence = max(0.0, min(1.0, (sim + 1.0) / 2.0))
            out.append({
                "start":            start_t,
                "end":              end_t,
                "label":            f"Motif {motif_idx} · {occ_idx + 1}/{occ_count}",
                "motif_id":         motif_idx,
                "occurrence_index": occ_idx,
                "occurrence_count": occ_count,
                "confidence":       confidence,
            })

    # Order by start time for the UI.
    out.sort(key=lambda p: p["start"])
    return out, duration


def detect_locomotif(audio_path: Path) -> dict:
    algo = "locomotif"
    if not (_LIBROSA_OK and _NUMPY_OK):
        return _err(algo, "librosa / numpy not installed")
    if not _LOCOMOTIF_OK:
        return _err(algo, "dtai-locomotif not installed (pip install dtai-locomotif)")
    t0 = datetime.now().timestamp() * 1000
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        patterns, duration = _detect_locomotif(y, sr)
        return {
            "algorithm": algo,
            "ok":        True,
            "patterns":  patterns,
            "duration":  duration,
            "ms":        _time_ms(t0),
        }
    except Exception as e:
        return _err(algo, f"{type(e).__name__}: {e}")


# ─── Algorithm registry ─────────────────────────────────────────────────────

ALGORITHMS = {
    "locomotif": {
        "name":        "LoCoMotif",
        "description": "DTW-warped motif discovery on beat-synchronous chroma. Each motif set yields one entry per occurrence (variable-length, not necessarily evenly spaced).",
        "detect":      detect_locomotif,
        "available":   lambda: _LIBROSA_OK and _NUMPY_OK and _LOCOMOTIF_OK,
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
        "patterns":    result.get("patterns", []),
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
        if path == "/api/pattern/health":
            self._send(200, {
                "ok": _LIBROSA_OK and _NUMPY_OK and _LOCOMOTIF_OK,
                "librosaOk": _LIBROSA_OK,
                "numpyOk": _NUMPY_OK,
                "locomotifOk": _LOCOMOTIF_OK,
            })
            return
        if path == "/api/pattern/algorithms":
            self._send(200, [
                {"id": k, "name": v["name"], "description": v["description"], "available": bool(v["available"]())}
                for k, v in ALGORITHMS.items()
            ])
            return
        if path.startswith("/api/pattern/detect/"):
            tail = path[len("/api/pattern/detect/"):].split("/")
            if len(tail) != 2:
                self._send(400, {"error": "expected /api/pattern/detect/<slug>/<algo>"})
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
        if path == "/api/pattern/detect":
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
        if path == "/api/pattern/initialize":
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
    print(f"Starting PATTERN server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  librosa={_LIBROSA_OK}  numpy={_NUMPY_OK}  locomotif={_LOCOMOTIF_OK}", file=sys.stderr)
    HTTPServer((host, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
