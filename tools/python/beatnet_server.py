#!/usr/bin/env python3
"""
BeatNet CUE-family detector — beats + downbeats + meter inference.

Sibling to bpm_server.py (:8004). BeatNet is heavier than the existing librosa
+ madmom detectors so it lives in its own process: a `pip install BeatNet`
problem on amd64+arm64 doesn't have to take the bpm server down with it. Same
JSON contract as bpm_server's algorithm entries so the chip UI can render its
output without special-casing.

Detector
--------
  beatnet   CRNN + Monte Carlo particle filter (Heydari & Duan, 2021)
            ~20 MB checkpoint, MIT licence. Returns beats + downbeats + a
            song-level meter (e.g. "4/4", "3/4") inferred from the per-beat
            downbeat labels.

Endpoints
---------
  GET  /api/beatnet/health           → server up + dep availability
  GET  /api/beatnet/detect/:slug     → cached result, or null
  POST /api/beatnet/detect           { slug, force? } — run BeatNet

Output schema
-------------
  {
    "slug":        str,
    "audio_file":  str,
    "duration":    float,
    "result": {
      "source":      "beatnet",
      "ok":          bool,
      "bpm":         float | None,    # 60 / median(diff(beat_times))
      "beat_times":  [float],         # all beats (seconds)
      "downbeats":   [float],         # subset where beat-label == 1
      "meter":       str | None,      # "4/4", "3/4", … or None if unsure
      "error":       str | None,
      "ms":          int
    },
    "computed_at": str                 # ISO-8601 UTC
  }

Cache
-----
  data/algorithm-outputs/beatnet/<slug>.json

Gated by the `experimental-models` docker compose profile (so the prod build
opts out completely) and the `experimentalCueExtras` user setting (so the UI
chip stays hidden until the user opts in).
"""

from __future__ import annotations

import json
import sys
import warnings
from collections import Counter
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

warnings.filterwarnings("ignore")

PORT = 8010

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import find_audio, BEATNET_OUTPUTS_DIR as CACHE_DIR  # noqa: E402

CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ─── Optional imports ───────────────────────────────────────────────────────

try:
    import numpy as np
    _NUMPY_OK = True
except ImportError:
    _NUMPY_OK = False

try:
    # BeatNet pulls in madmom + torch transitively. We import lazily inside
    # the detector so the server can boot even on partial installs and
    # report dep status through /api/beatnet/health.
    import BeatNet  # noqa: F401
    _BEATNET_OK = True
except Exception:
    _BEATNET_OK = False


# Process-wide model cache. Loading takes a few seconds; keep the estimator
# alive between requests.
_beatnet_estimator = None


def _time_ms(t0_ms: float) -> int:
    return int((datetime.now().timestamp() * 1000) - t0_ms)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _infer_meter(beat_labels: list[int]) -> str | None:
    """Infer meter (numerator/4) from BeatNet's per-beat position labels.

    BeatNet emits `1` for downbeats and `2..N` for non-downbeats. The mode of
    the per-bar beat count gives the numerator. We only return a meter if we
    have at least two bars to compare; otherwise None (caller should treat as
    unknown rather than confidently 4/4).
    """
    if not beat_labels:
        return None
    bars: list[int] = []
    current = 0
    for lbl in beat_labels:
        if lbl == 1 and current > 0:
            bars.append(current)
            current = 1
        else:
            current += 1
    if current > 0:
        bars.append(current)
    if len(bars) < 2:
        return None
    # The first / last "bars" can be partial — discard them when there are
    # plenty of complete ones in the middle.
    middle = bars[1:-1] if len(bars) > 4 else bars
    counts = Counter(middle)
    most_common, votes = counts.most_common(1)[0]
    if votes < max(2, len(middle) // 2):
        return None
    return f"{most_common}/4"


def _ensure_beatnet():
    """Construct the offline BeatNet estimator on first use."""
    global _beatnet_estimator
    if _beatnet_estimator is not None:
        return
    from BeatNet.BeatNet import BeatNet  # type: ignore[import-not-found]
    # model=1 is the default checkpoint released with the paper; mode='offline'
    # uses the full bidirectional CRNN (online mode is causal and less
    # accurate). inference_model='DBN' runs the dynamic-Bayesian-network
    # post-filter; 'PF' would use the particle filter (slower).
    _beatnet_estimator = BeatNet(
        1,
        mode="offline",
        inference_model="DBN",
        plot=[],
        thread=False,
    )


def detect_beatnet(audio_path: Path) -> dict:
    src = "beatnet"
    if not (_BEATNET_OK and _NUMPY_OK):
        return {"source": src, "ok": False, "error": "BeatNet / numpy not installed"}
    t0 = datetime.now().timestamp() * 1000
    try:
        _ensure_beatnet()
        # BeatNet.process returns ndarray of shape (N, 2): [time_sec, beat_label]
        out = _beatnet_estimator.process(str(audio_path))  # type: ignore[union-attr]
        if out is None or len(out) == 0:
            return {"source": src, "ok": False, "error": "no beats detected"}
        out = np.asarray(out)
        times = [float(t) for t in out[:, 0]]
        labels = [int(round(float(l))) for l in out[:, 1]]
        downbeats = [t for t, l in zip(times, labels) if l == 1]
        # Tempo from the median inter-beat interval (matches madmom-rnn-beats).
        if len(times) >= 2:
            ibis = np.diff(times)
            median_ibi = float(np.median(ibis))
            bpm = float(60.0 / median_ibi) if median_ibi > 0 else None
        else:
            bpm = None
        meter = _infer_meter(labels)
        return {
            "source":     src,
            "ok":         True,
            "bpm":        bpm,
            "beat_times": times,
            "downbeats":  downbeats,
            "meter":      meter,
            "ms":         _time_ms(t0),
        }
    except Exception as e:
        return {"source": src, "ok": False, "error": f"{type(e).__name__}: {e}"}


def detect(slug: str, force: bool = False) -> dict:
    cache_path = CACHE_DIR / f"{slug}.json"
    if cache_path.exists() and not force:
        return json.loads(cache_path.read_text())

    audio_path = find_audio(slug)
    if audio_path is None:
        raise FileNotFoundError(f"audio not found for slug: {slug}")

    result = detect_beatnet(audio_path)
    # Best-effort duration via librosa if BeatNet didn't return one; mostly
    # informational so don't fail the whole detection if it can't be computed.
    duration = 0.0
    try:
        import librosa  # type: ignore[import-not-found]
        duration = float(librosa.get_duration(path=str(audio_path)))
    except Exception:
        pass

    payload = {
        "slug":        slug,
        "audio_file":  audio_path.name,
        "duration":    duration,
        "result":      result,
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

        if path == "/api/beatnet/health":
            self._send(200, {
                "ok":         _BEATNET_OK and _NUMPY_OK,
                "beatnetOk":  _BEATNET_OK,
                "numpyOk":    _NUMPY_OK,
            })
            return

        if path.startswith("/api/beatnet/detect/"):
            slug = path[len("/api/beatnet/detect/"):]
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

        if path == "/api/beatnet/detect":
            slug  = str(body.get("slug", "")).strip()
            force = bool(body.get("force", False))
            if not slug:
                self._send(400, {"error": "slug is required"})
                return
            try:
                self._send(200, detect(slug, force=force))
            except FileNotFoundError as e:
                self._send(404, {"error": str(e)})
            except Exception as e:
                self._send(500, {"error": f"detection failed: {type(e).__name__}: {e}"})
            return

        # Warm the BeatNet estimator without running detection. Mirror of
        # /api/span/initialize so the "Initialize models" panel can light up
        # both families with the same UI logic.
        if path == "/api/beatnet/initialize":
            if not (_BEATNET_OK and _NUMPY_OK):
                self._send(503, {"ok": False, "error": "BeatNet / numpy not installed"})
                return
            try:
                _ensure_beatnet()
                self._send(200, {"ok": True, "algorithm": "beatnet"})
            except Exception as e:
                self._send(500, {"ok": False, "error": f"init failed: {type(e).__name__}: {e}"})
            return

        self._send(404, {"error": "not found"})


def main():
    import os
    host = os.environ.get("HOST", "localhost")
    print(f"Starting BeatNet server on http://{host}:{PORT}", file=sys.stderr)
    print(f"  BeatNet={_BEATNET_OK}  numpy={_NUMPY_OK}", file=sys.stderr)
    server = HTTPServer((host, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
