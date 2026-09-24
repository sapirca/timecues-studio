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
  madmom-dbn-downbeats  RNNDownBeatProcessor + DBNDownBeat  (if madmom)
  madmom-tempo          TempoEstimationProcessor (RNN+ACF)  (if madmom)

Endpoints
---------
  GET  /api/bpm/health              → availability per detector
  GET  /api/bpm/detect/:slug        → return cached result, or null
  POST /api/bpm/detect              { slug, force?, start?, end? } — run all
                                    detectors, over the whole song or over
                                    just the [start, end) seconds given (used
                                    by DataPrep to read one grid segment's
                                    own tempo). Ranged results carry a
                                    `range` key and are never cached.

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
from datetime import datetime
from contextlib import nullcontext
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8004

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import REPO_ROOT, find_audio, safe_segment, BPM_DETECTIONS_DIR as CACHE_DIR  # noqa: E402
from server_common import (  # noqa: E402
    cached_result, cors_headers, now_iso, parse_range, shift_times, time_ms,
    trimmed_audio,
)

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
            "ms":         time_ms(t0),
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
        return {"source": src, "ok": True, "bpm": bpm, "ms": time_ms(t0)}
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
        return {"source": src, "ok": True, "bpm": bpm, "ms": time_ms(t0)}
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
            "ms":         time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def detect_madmom_dbn_downbeats(audio_path: Path) -> dict:
    """madmom's joint beat + DOWNBEAT tracker.

    The existing madmom-rnn-beats above finds beats only. Downbeats are the
    harder and more valuable half: on EDM a tracker's beat F1 sits around
    0.95 because four-on-the-floor is trivial, while its downbeat F1 drops to
    around 0.67 (Raveform, TISMIR 2025) — and the downbeat is what a grid
    segment's bar 1 is anchored to.

    `beats_per_bar=[3, 4]` is the DBN's hypothesis set, not an assertion: it
    decides between 3/4 and 4/4 from the audio. Meters outside that list
    (this corpus has a 5/4 track) are not representable, which is one of the
    DBN limitations the Beat This! paper singles out.
    """
    src = "madmom-dbn-downbeats"
    if not _MADMOM_OK:
        return {"source": src, "ok": False, "error": "madmom not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        from madmom.features.downbeats import (
            RNNDownBeatProcessor, DBNDownBeatTrackingProcessor,
        )
        act = RNNDownBeatProcessor()(str(audio_path))
        # Returns (N, 2): [time_sec, beat_position_in_bar] where position 1
        # is the downbeat.
        out = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)(act)
        if out is None or len(out) == 0:
            return {"source": src, "ok": False, "error": "no beats detected"}
        out = np.asarray(out)
        beat_times = [float(t) for t in out[:, 0]]
        positions  = [int(round(float(p))) for p in out[:, 1]]
        downbeats  = [t for t, p in zip(beat_times, positions) if p == 1]
        if len(beat_times) < 2:
            return {"source": src, "ok": False, "error": "fewer than 2 beats detected"}
        median_ibi = float(np.median(np.diff(beat_times)))
        bpm = 60.0 / median_ibi if median_ibi > 0 else 0.0
        return {
            "source":     src,
            "ok":         True,
            "bpm":        bpm,
            "beat_times": beat_times,
            "downbeats":  downbeats,
            "ms":         time_ms(t0),
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
            "ms":         time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


# ─── Orchestration ───────────────────────────────────────────────────────────

def detect_all(slug: str, force: bool = False, span: "tuple[float, float] | None" = None) -> dict:
    """Run every detector on `slug`, or — when `span` is given — on just that
    `[start, end)` window of it.

    A range result is deliberately never cached, in either direction. It is
    asked once for one grid segment, and that segment's bounds move whenever
    the curator drags its head; a cache would have to be keyed on a pair of
    floats to avoid handing back an answer about audio the segment no longer
    covers. Reading the whole-song cache would be worse still — it would
    return the song's tempo dressed up as the segment's.
    """
    cache_path = CACHE_DIR / f"{slug}.json"
    if span is None:
        hit = cached_result(cache_path, force)
        if hit is not None:
            return hit

    audio_path = _find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    start, end = span if span else (0.0, None)

    # Load once for the librosa detectors; the file-based detectors reload
    # themselves so they can use their own preferred sample rates.
    if _LIBROSA_OK:
        y, sr = librosa.load(
            str(audio_path), sr=22050, mono=True,
            offset=start, duration=(end - start) if span else None,
        )
        duration = float(len(y) / sr)
    else:
        y, sr, duration = None, None, 0.0

    # The madmom detectors take a path, so a range request gets a real file
    # holding only the range. nullcontext keeps the whole-song path allocation
    # -free — it hands back the song's own file untouched.
    trim = trimmed_audio(audio_path, start, end) if span else nullcontext(audio_path)
    with trim as detector_path:
        algorithms = [
            detect_librosa_beat_track(y, sr)    if _LIBROSA_OK else _skip("librosa-beat-track"),
            detect_librosa_tempo_static(y, sr)  if _LIBROSA_OK else _skip("librosa-tempo-static"),
            detect_librosa_tempo_dynamic(y, sr) if _LIBROSA_OK else _skip("librosa-tempo-dynamic"),
            detect_madmom_rnn_beats(detector_path),
            detect_madmom_dbn_downbeats(detector_path),
            detect_madmom_tempo(detector_path),
        ]

    if span:
        # Every detector just answered about a file that starts at zero.
        for algorithm in algorithms:
            shift_times(algorithm, start)

    result = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    duration,
        "algorithms":  algorithms,
        "computed_at": now_iso(),
    }
    if span:
        result["range"] = {"start": start, "end": end}
        return result

    try:
        cache_path.write_text(json.dumps(result, indent=2))
    except Exception:
        pass
    return result


def _skip(source: str) -> dict:
    return {"source": source, "ok": False, "error": "librosa not installed"}


# ─── HTTP handler ────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else "???"
        if not code.isdigit() or int(code) >= 400:
            super().log_message(fmt, *args)

    def _send(self, code: int, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in cors_headers().items():
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
                span = parse_range(body)
            except ValueError as e:
                self._send(400, {"error": str(e)}); return
            try:
                self._send(200, detect_all(slug, force=force, span=span))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
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
