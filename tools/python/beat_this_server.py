#!/usr/bin/env python3
"""
Beat This! CUE-family detector — beats + downbeats + fitted grid SEGMENTS.

Sibling to beatnet_server.py (:8010) and bpm_server.py (:8004). Same JSON
contract as bpm_server's algorithm entries so the chip UI renders it without
special-casing, plus the two fields only this server produces: `downbeats`
and `segments`.

Detector
--------
  beat-this  Transformer beat/downbeat tracker (Foscarin, Schlüter & Widmer,
             ISMIR 2024). MIT licence on BOTH the code and the published
             weights — which is why it is here rather than another madmom
             checkpoint: NOTICE.md has to keep flagging the CPJKU pretrained
             beat trackers because some of those checkpoints historically
             carried CC-BY-NC terms. This one adds no such footnote.

             It also drops the DBN post-processing that makes madmom pull its
             answer toward one globally-consistent tempo. That smoothing is
             exactly wrong for a track whose grid genuinely restarts, so the
             un-smoothed output is the more useful input to the segment fit
             below, not merely the more accurate one.

Why segments and not just beats
-------------------------------
Every tracker stops at a flat list of beat times. TimeCues' grid model is a
handful of segments, each a hard restart with its own tempo and bar 1. The
step between the two is beat_segments.fit_segments(), which is where the
interesting distinctions live (tempo change vs. phase shift vs. a breakdown
the tracker simply went quiet through). See that module's docstring.

Endpoints
---------
  GET  /api/beat-this/health           → server up + dep availability
  GET  /api/beat-this/detect/:slug     → cached result, or null
  POST /api/beat-this/detect           { slug, force?, start?, end? } — run
                                       over the song, or over just the
                                       [start, end) seconds given.
  POST /api/beat-this/initialize       → warm the model without detecting

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "duration":    float,
    "result": {
      "source":      "beat-this",
      "ok":          bool,
      "bpm":         float | None,    # 60 / median(diff(beat_times))
      "beat_times":  [float],
      "downbeats":   [float],
      "meter":       str | None,      # from the opening segment
      "segments":    [ { start, end, bpm, time_signature, beats, reason } ],
      "summary":     { segments, tempo_changes, phase_shifts, constant_tempo },
      "error":       str | None,
      "ms":          int
    },
    "computed_at": str                 # ISO-8601 UTC
  }

Cache
-----
  data/algorithm-outputs/beat-this/<slug>.json

Gated by the `experimental-models` docker compose profile (so the prod build
opts out completely) and the `experimentalCueExtras` user setting (so the UI
chip stays hidden until the user opts in).
"""

from __future__ import annotations

import json
import os
import sys
import warnings
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8008

sys.path.insert(0, str(Path(__file__).resolve().parent))
from beat_segments import fit_segments, summarize  # noqa: E402
from paths import find_audio, BEAT_THIS_OUTPUTS_DIR as CACHE_DIR  # noqa: E402
from server_common import (  # noqa: E402
    cached_result, cors_headers, now_iso, parse_range, shift_times, time_ms,
    trimmed_audio,
)

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Which released checkpoint to run. "final0" is the single-model default from
# the paper; "final0,final1,final2" would ensemble the three at 3x the cost.
CHECKPOINT = os.environ.get("BEAT_THIS_CHECKPOINT", "final0")
# CPU is the default deliberately: this sidecar runs on machines with no GPU
# (the prod VM is a 2 GB e2-small) and the model is small enough that CPU
# inference on a 3-minute track is tens of seconds, not minutes.
DEVICE = os.environ.get("BEAT_THIS_DEVICE", "cpu")

# ─── Optional imports ───────────────────────────────────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    # beat_this pulls torch. Import is probed here but the model is built
    # lazily in _ensure_model() so a partial install still boots the server
    # and reports its state through /api/beat-this/health.
    import beat_this  # noqa: F401
    _BEAT_THIS_OK = True
except Exception:
    _BEAT_THIS_OK = False


# Process-wide model cache. The checkpoint download + load takes a few
# seconds; keep it alive between requests.
_file2beats = None


def _ensure_model():
    """Construct the File2Beats pipeline on first use."""
    global _file2beats
    if _file2beats is not None:
        return
    from beat_this.inference import File2Beats  # type: ignore[import-not-found]
    # dbn=False is the paper's headline result: the transformer's own
    # post-processing beats the DBN, and skipping it avoids pulling madmom
    # into this image at all.
    _file2beats = File2Beats(checkpoint_path=CHECKPOINT, device=DEVICE, dbn=False)


def detect_beat_this(audio_path: Path) -> dict:
    src = "beat-this"
    if not (_BEAT_THIS_OK and _NUMPY_OK):
        return {"source": src, "ok": False, "error": "beat_this / numpy not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_model()
        # File2Beats returns (beats, downbeats) as float arrays of seconds.
        # downbeats is a SUBSET of beats, not a separate sequence.
        beats, downbeats = _file2beats(str(audio_path))  # type: ignore[misc]
        beat_times = [float(t) for t in np.asarray(beats).ravel()]
        down_times = [float(t) for t in np.asarray(downbeats).ravel()]
        if not beat_times:
            return {"source": src, "ok": False, "error": "no beats detected"}

        if len(beat_times) >= 2:
            median_ibi = float(np.median(np.diff(beat_times)))
            bpm = float(60.0 / median_ibi) if median_ibi > 0 else None
        else:
            bpm = None

        return {
            "source":     src,
            "ok":         True,
            "bpm":        bpm,
            "beat_times": beat_times,
            "downbeats":  down_times,
            "ms":         time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def _add_segments(result: dict, duration: "float | None") -> dict:
    """Fit grid segments onto a successful detection, in place.

    Kept out of detect_beat_this so the fit runs on SONG-time beats: a ranged
    detection has its timestamps shifted back into song time first, and
    segments carrying range-local times would be silently wrong in a way that
    looks entirely plausible on screen.
    """
    if not result.get("ok"):
        return result
    segments = fit_segments(
        result.get("beat_times", []),
        result.get("downbeats", []),
        duration=duration,
    )
    result["segments"] = segments
    result["summary"] = summarize(segments)
    # The song-level meter chip wants one answer; the opening segment's is
    # the one that describes how the song starts.
    result["meter"] = segments[0]["time_signature"] if segments else None
    return result


def detect(slug: str, force: bool = False, span: "tuple[float, float] | None" = None) -> dict:
    """Run Beat This! over `slug`, or over just the `[start, end)` window.

    The ranged form is what DataPrep's Mapped grid mode asks for — same
    contract as beatnet_server.detect. Ranged results are not cached.
    """
    cache_path = CACHE_DIR / f"{slug}.json"
    if span is None:
        hit = cached_result(cache_path, force)
        if hit is not None:
            return hit

    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    if span:
        # File2Beats takes a path, so the range has to become a real file.
        with trimmed_audio(audio_path, *span) as ranged_path:
            result = shift_times(detect_beat_this(ranged_path), span[0])
        _add_segments(result, float(span[1] - span[0]))
        return {
            "slug":        slug,
            "audio_file":  audio_path.name,
            "duration":    float(span[1] - span[0]),
            "range":       {"start": span[0], "end": span[1]},
            "result":      result,
            "computed_at": now_iso(),
        }

    result = detect_beat_this(audio_path)
    # Best-effort duration; informational, so don't fail the detection over it.
    duration = 0.0
    try:
        import librosa  # type: ignore[import-not-found]
        duration = float(librosa.get_duration(path=str(audio_path)))
    except Exception:
        pass
    _add_segments(result, duration or None)

    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    duration,
        "result":      result,
        "computed_at": now_iso(),
    }
    try:
        cache_path.write_text(json.dumps(payload, indent=2))
    except Exception:
        pass
    return payload


# ─── HTTP handler ───────────────────────────────────────────────────────────

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

        if path == "/api/beat-this/health":
            self._send(200, {
                "ok":          _BEAT_THIS_OK and _NUMPY_OK,
                "beatThisOk":  _BEAT_THIS_OK,
                "numpyOk":     _NUMPY_OK,
                "checkpoint":  CHECKPOINT,
                "device":      DEVICE,
            })
            return

        if path.startswith("/api/beat-this/detect/"):
            slug = path[len("/api/beat-this/detect/"):]
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
            self._send(400, {"error": f"invalid JSON: {e}"})
            return

        if path == "/api/beat-this/detect":
            slug  = str(body.get("slug", "")).strip()
            force = bool(body.get("force", False))
            if not slug:
                self._send(400, {"error": "slug is required"})
                return
            try:
                span = parse_range(body)
            except ValueError as e:
                self._send(400, {"error": str(e)}); return
            try:
                self._send(200, detect(slug, force=force, span=span))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return

        # Warm the model without running detection — mirror of
        # /api/beatnet/initialize so the "Initialize models" panel can light
        # up both families with the same UI logic.
        if path == "/api/beat-this/initialize":
            if not (_BEAT_THIS_OK and _NUMPY_OK):
                self._send(503, {"ok": False, "error": "beat_this / numpy not installed"})
                return
            try:
                _ensure_model()
                self._send(200, {"ok": True, "algorithm": "beat-this"})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return

        self._send(404, {"error": "not found"})


def main():
    host = os.environ.get("HOST", "localhost")
    print(f"Starting Beat This! server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  beat_this={_BEAT_THIS_OK}  numpy={_NUMPY_OK}  "
          f"checkpoint={CHECKPOINT}  device={DEVICE}", file=sys.stderr)
    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
