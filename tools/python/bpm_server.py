#!/usr/bin/env python3
"""
BPM Detection Server — runs every available BPM/tempo estimator on a song
and returns each detector's estimate (no consensus / no averaging).

Detectors
---------
  librosa-beat-track    librosa.beat.beat_track             (always)
  librosa-tempo-static  librosa.feature.rhythm.tempo()      (always)
  librosa-tempo-dynamic librosa.feature.rhythm.tempo(agg=None) — median over frames
  madmom-rnn-beats      RNNBeatProcessor + DBNBeatTracking  (if madmom)
  madmom-tempo          TempoEstimationProcessor (RNN+ACF)  (if madmom)

Endpoints
---------
  GET  /api/bpm/health              → availability per detector
  GET  /api/bpm/detect/:slug        → return cached result, or null
  POST /api/bpm/detect              { slug, force? } — run all detectors

Cache
-----
  bpm-detections/<slug>.json (gitignored — local cache)

Usage
-----
  pip install librosa madmom
  python tools/python/bpm_server.py
  # → http://localhost:8004
"""

import json
import sys
import warnings
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8004

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import REPO_ROOT, find_audio, safe_segment, BPM_DETECTIONS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── Optional imports (each detector is independent) ─────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    import librosa
    _LIBROSA_OK = True
    # librosa moved tempo from .beat to .feature.rhythm in 0.10
    _librosa_tempo_fn = getattr(getattr(librosa, "feature", None), "rhythm", None)
    _librosa_tempo_fn = getattr(_librosa_tempo_fn, "tempo", None) if _librosa_tempo_fn else None
    if _librosa_tempo_fn is None:
        _librosa_tempo_fn = getattr(librosa.beat, "tempo", None)
except ImportError:
    _LIBROSA_OK = False
    _librosa_tempo_fn = None

try:
    import madmom  # noqa: F401
    _MADMOM_OK = True
except Exception:
    # madmom imports can fail at runtime (numpy ABI) — treat as unavailable.
    _MADMOM_OK = False


# ─── Audio lookup ────────────────────────────────────────────────────────────

def _find_audio(slug: str) -> "Path | None":
    return find_audio(slug)


# ─── Detectors ───────────────────────────────────────────────────────────────
# Each returns a result dict:
#   { source, ok, bpm?, error?, beat_times?, candidates?, ms? }
# Detectors swallow their own exceptions and report ok=False on failure so a
# single bad detector never blocks the others.

def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def detect_librosa_beat_track(y, sr) -> dict:
    src = "librosa-beat-track"
    if not _LIBROSA_OK:
        return {"source": src, "ok": False, "error": "librosa not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beats, sr=sr).tolist()
        bpm = float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo)
        return {
            "source":     src,
            "ok":         True,
            "bpm":        bpm,
            "beat_times": beat_times,
            "ms":         _time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def detect_librosa_tempo_static(y, sr) -> dict:
    src = "librosa-tempo-static"
    if not _LIBROSA_OK or _librosa_tempo_fn is None:
        return {"source": src, "ok": False, "error": "librosa.tempo unavailable"}
    t0 = datetime.now().timestamp() * 1000
    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempo = _librosa_tempo_fn(onset_envelope=onset_env, sr=sr)
        bpm = float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo)
        return {"source": src, "ok": True, "bpm": bpm, "ms": _time_ms(t0)}
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def detect_librosa_tempo_dynamic(y, sr) -> dict:
    src = "librosa-tempo-dynamic"
    if not _LIBROSA_OK or _librosa_tempo_fn is None:
        return {"source": src, "ok": False, "error": "librosa.tempo unavailable"}
    t0 = datetime.now().timestamp() * 1000
    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        tempos = _librosa_tempo_fn(onset_envelope=onset_env, sr=sr, aggregate=None)
        # Median over per-frame tempo estimates.
        bpm = float(np.median(tempos))
        return {"source": src, "ok": True, "bpm": bpm, "ms": _time_ms(t0)}
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def compute_tempo_curve(y, sr) -> dict:
    """Per-frame tempo curve (librosa). Drives Dynamic mode anchor derivation
    on the client side. Returns { frame_times, bpms } at librosa's default
    hop_length (512 → ~23 ms/frame at sr=22050)."""
    src = "librosa-tempo-curve"
    if not _LIBROSA_OK or _librosa_tempo_fn is None:
        return {"source": src, "ok": False, "error": "librosa.tempo unavailable"}
    t0 = datetime.now().timestamp() * 1000
    try:
        hop_length = 512
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
        tempos = _librosa_tempo_fn(
            onset_envelope=onset_env, sr=sr, hop_length=hop_length, aggregate=None,
        )
        n_frames = len(tempos)
        # librosa tempo() with aggregate=None returns one tempo per onset
        # envelope frame; frame i covers approximately i * hop / sr seconds.
        frame_times = (np.arange(n_frames) * hop_length / sr).tolist()
        return {
            "source":      src,
            "ok":          True,
            "frame_times": frame_times,
            "bpms":        [float(t) for t in tempos],
            "hop_length":  int(hop_length),
            "sr":          int(sr),
            "ms":          _time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def detect_madmom_rnn_beats(audio_path: Path) -> dict:
    src = "madmom-rnn-beats"
    if not _MADMOM_OK:
        return {"source": src, "ok": False, "error": "madmom not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        from madmom.features.beats import RNNBeatProcessor, DBNBeatTrackingProcessor
        act = RNNBeatProcessor()(str(audio_path))
        beats = DBNBeatTrackingProcessor(fps=100)(act)
        beat_times = [float(b) for b in beats]
        if len(beat_times) < 2:
            return {"source": src, "ok": False, "error": "fewer than 2 beats detected"}
        # Tempo from median inter-beat interval (more robust than mean).
        ibis = np.diff(beat_times)
        median_ibi = float(np.median(ibis))
        bpm = 60.0 / median_ibi if median_ibi > 0 else 0.0
        return {
            "source":     src,
            "ok":         True,
            "bpm":        bpm,
            "beat_times": beat_times,
            "ms":         _time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def detect_madmom_tempo(audio_path: Path) -> dict:
    src = "madmom-tempo"
    if not _MADMOM_OK:
        return {"source": src, "ok": False, "error": "madmom not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        from madmom.features.beats import RNNBeatProcessor
        from madmom.features.tempo import TempoEstimationProcessor
        act = RNNBeatProcessor()(str(audio_path))
        candidates = TempoEstimationProcessor(fps=100)(act)
        # candidates: ndarray of shape (N, 2) — (tempo, strength), sorted by strength desc.
        if len(candidates) == 0:
            return {"source": src, "ok": False, "error": "no tempo candidates"}
        cand_list = [{"bpm": float(c[0]), "strength": float(c[1])} for c in candidates[:5]]
        return {
            "source":     src,
            "ok":         True,
            "bpm":        cand_list[0]["bpm"],
            "candidates": cand_list,
            "ms":         _time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


# ─── Orchestration ───────────────────────────────────────────────────────────

def detect_all(slug: str, force: bool = False) -> dict:
    cache_path = CACHE_DIR / f"{slug}.json"
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())

    audio_path = _find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    # Load once for the librosa detectors; the file-based detectors reload
    # themselves so they can use their own preferred sample rates.
    if _LIBROSA_OK:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
        duration = float(len(y) / sr)
    else:
        y, sr, duration = None, None, 0.0

    algorithms = [
        detect_librosa_beat_track(y, sr)    if _LIBROSA_OK else _skip("librosa-beat-track"),
        detect_librosa_tempo_static(y, sr)  if _LIBROSA_OK else _skip("librosa-tempo-static"),
        detect_librosa_tempo_dynamic(y, sr) if _LIBROSA_OK else _skip("librosa-tempo-dynamic"),
        detect_madmom_rnn_beats(audio_path),
        detect_madmom_tempo(audio_path),
    ]

    result = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    duration,
        "algorithms":  algorithms,
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        cache_path.write_text(json.dumps(result, indent=2))
    except Exception:
        pass
    return result


def _skip(source: str) -> dict:
    return {"source": source, "ok": False, "error": "librosa not installed"}


def compute_curve(slug: str, force: bool = False) -> dict:
    """Compute (and cache) the per-frame tempo curve for `slug`. Drives the
    DataPrep "Dynamic" grid mode on the client. Cached separately from the
    main detection result (single-detector payload, larger arrays)."""
    curve_path = CACHE_DIR / f"{slug}.curve.json"
    if curve_path.exists() and not force:
        return json.loads(curve_path.read_text())

    audio_path = _find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    if not _LIBROSA_OK:
        return {"slug": slug, "ok": False, "error": "librosa not installed"}

    y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    curve = compute_tempo_curve(y, sr)
    result = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    float(len(y) / sr),
        "curve":       curve,
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    try:
        curve_path.write_text(json.dumps(result))
    except Exception:
        pass
    return result


# ─── HTTP handler ────────────────────────────────────────────────────────────

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

        if path == "/api/bpm/health":
            self._send(200, {
                "ok":         _LIBROSA_OK,
                "librosaOk":  _LIBROSA_OK,
                "madmomOk":   _MADMOM_OK,
            })
            return

        if path.startswith("/api/bpm/detect/"):
            slug = path[len("/api/bpm/detect/"):]
            cache_path = CACHE_DIR / f"{slug}.json"
            if cache_path.exists():
                self._send(200, json.loads(cache_path.read_text()))
            else:
                self._send(200, None)
            return

        # Per-frame tempo curve. Returns null when nothing is cached so the
        # client can decide whether to trigger a POST.
        if path.startswith("/api/bpm/tempo-curve/"):
            slug = path[len("/api/bpm/tempo-curve/"):]
            curve_path = CACHE_DIR / f"{slug}.curve.json"
            if curve_path.exists():
                self._send(200, json.loads(curve_path.read_text()))
            else:
                self._send(200, None)
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):
        path   = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length)) if length else {}
        except json.JSONDecodeError as e:
            self._send(400, {"error": f"invalid JSON: {e}"}); return

        if path == "/api/bpm/detect":
            slug  = safe_segment(str(body.get("slug", "")).strip())
            force = bool(body.get("force", False))
            if not slug:
                self._send(400, {"error": "invalid or missing slug"}); return
            try:
                self._send(200, detect_all(slug, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return

        if path == "/api/bpm/tempo-curve":
            slug  = safe_segment(str(body.get("slug", "")).strip())
            force = bool(body.get("force", False))
            if not slug:
                self._send(400, {"error": "invalid or missing slug"}); return
            try:
                self._send(200, compute_curve(slug, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"tempo-curve failed: {type(e).__name__}: {e}"})
            return

        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting BPM server on http://{host}:{PORT}", file=sys.stderr)
    print(
        f"  librosa={_LIBROSA_OK}  madmom={_MADMOM_OK}",
        file=sys.stderr,
    )
    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
